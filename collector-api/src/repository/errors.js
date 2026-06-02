export class RepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new RepositoryError(code, message);
}
