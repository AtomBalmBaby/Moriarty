/**
 * The composer's Stop/Send state. It follows the host's operation lifecycle:
 * an operation opens when the host starts working on a message and closes
 * only at the host's terminal event, so Stop stays available through
 * Feedback, continuations, and the gaps between model requests.
 */

export type ComposerOperationPhase = "idle" | "running" | "stopping"

export type ComposerOperationEvent =
  | { type: "started" }
  | { type: "stop-requested" }
  | { type: "terminal" }

export const reduceComposerOperation = (
  phase: ComposerOperationPhase,
  event: ComposerOperationEvent
): ComposerOperationPhase => {
  switch (event.type) {
    case "started":
      // A late start must not undo a stop already requested.
      return phase === "idle" ? "running" : phase
    case "stop-requested":
      return phase === "running" ? "stopping" : phase
    case "terminal":
      return "idle"
  }
}

/** Busy from the first start until the terminal event. */
export const composerIsBusy = (phase: ComposerOperationPhase): boolean => phase !== "idle"
