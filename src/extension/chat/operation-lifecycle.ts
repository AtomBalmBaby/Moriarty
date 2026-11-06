/**
 * One chat operation can span Feedback planning, several model turns with
 * automatic continuations, and reviews. Nested runs share one operation: the
 * terminal event is announced once, when the outermost run settles.
 */
export class OperationLifecycle {
  private depth = 0

  constructor(
    private readonly opened: () => void,
    private readonly terminal: () => void
  ) {}

  get active(): boolean {
    return this.depth > 0
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    this.depth += 1
    this.opened()
    try {
      return await body()
    } finally {
      this.depth -= 1
      if (this.depth === 0) this.terminal()
    }
  }

  /** Re-announce an open operation to a webview that has just connected. */
  reannounce(): void {
    if (this.active) this.opened()
  }
}
