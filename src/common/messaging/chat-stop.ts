export const shouldResumeQueuedChat = (userStopped: boolean, cancelled: boolean): boolean =>
  !userStopped && !cancelled
