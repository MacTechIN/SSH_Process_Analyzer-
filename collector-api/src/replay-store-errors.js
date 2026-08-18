export class ReplayConflictError extends Error {
  constructor() {
    super("replay record already exists");
    this.name = "ReplayConflictError";
    this.code = "REPLAY_DETECTED";
  }
}
