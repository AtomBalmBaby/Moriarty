import { AsyncLocalStorage } from "node:async_hooks"

interface Operation {
  id: string
  controller: AbortController
  depth: number
  ended: boolean
}

/** The operation whose work is running: continuations inherit it, so a cancelled one can tell it is stale. */
const owner = new AsyncLocalStorage<Operation>()

let operationCount = 0

/**
 * One chat operation can span Feedback planning, several model turns with
 * automatic continuations, and reviews. Nested runs share one operation: the
 * terminal event is announced once, when the outermost run settles, or when
 * the operation is cancelled. Cancellation does not wait for the work it
 * abandons, so a stalled planning or model call can never hold the operation open.
 */
export class OperationLifecycle {
  private current?: Operation

  constructor(
    private readonly opened: () => void,
    private readonly terminal: (operationId: string, outcome: "completed" | "cancelled") => void,
    private readonly trace: (event: string, operationId: string, detail?: string) => void = () => undefined
  ) {}

  get active(): boolean {
    return this.current !== undefined
  }

  get operationId(): string | undefined {
    return this.current?.id
  }

  /** True inside work that belongs to a cancelled operation. */
  get contextCancelled(): boolean {
    return owner.getStore()?.controller.signal.aborted ?? false
  }

  /**
   * Runs `body` as part of the open operation, or of a new one. Resolves to
   * undefined if the operation is cancelled first, and never to a late result.
   */
  async run<T>(body: () => Promise<T>): Promise<T | undefined> {
    // A continuation of a cancelled turn must not join or reopen a newer operation.
    if (this.contextCancelled) return undefined
    const operation = this.current ?? this.open()
    operation.depth += 1
    this.opened()
    // A synchronous throw from the body rejects like any other failure, and still ends the operation.
    const work = new Promise<T>((resolve) => resolve(owner.run(operation, body)))
    work.catch(() => undefined)
    try {
      return await raceAbort(work, operation.controller.signal)
    } catch (error) {
      if (operation.controller.signal.aborted) return undefined
      throw error
    } finally {
      operation.depth -= 1
      if (operation.depth === 0) this.finish(operation, "completed")
    }
  }

  /**
   * Cancels the open operation: its signal aborts and its terminal is announced
   * at once, without waiting for the abandoned work. Returns false when no
   * operation is open.
   */
  cancel(reason: string): boolean {
    const operation = this.current
    if (!operation) return false
    this.trace("operation.cancel-requested", operation.id, reason)
    if (!operation.controller.signal.aborted) operation.controller.abort(new Error(`Operation cancelled: ${reason}`))
    this.finish(operation, "cancelled")
    return true
  }

  /** Re-announce an open operation to a webview that has just connected. */
  reannounce(): void {
    if (this.active) this.opened()
  }

  private open(): Operation {
    operationCount += 1
    const operation: Operation = { id: `op-${operationCount}`, controller: new AbortController(), depth: 0, ended: false }
    this.current = operation
    this.trace("operation.opened", operation.id)
    return operation
  }

  private finish(operation: Operation, outcome: "completed" | "cancelled") {
    if (operation.ended) return
    operation.ended = true
    if (this.current === operation) this.current = undefined
    this.trace(outcome === "cancelled" ? "operation.cancel-acknowledged" : "operation.terminal", operation.id, outcome)
    this.terminal(operation.id, outcome)
  }
}

/** Rejects as soon as `signal` aborts, even while `work` never settles. */
const raceAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    if (signal.aborted) return stop()
    signal.addEventListener("abort", stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
  })
