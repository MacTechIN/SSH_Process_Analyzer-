export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function reject(status, code, message) {
  throw new ApiError(status, code, message);
}

const REPOSITORY_STATUS = {
  SNAPSHOT_HASH_CONFLICT: 409,
  GENERATION_DELETING: 409,
  PROCESS_KEY_CONFLICT: 409,
  HOST_NOT_FOUND: 409,
  AGENT_QUARANTINED: 403,
  AGENT_BINDING_MISMATCH: 403,
  GENERATION_NOT_FOUND: 409,
  GENERATION_NOT_READY: 409,
  GENERATION_NOT_STAGING: 409,
  BATCH_MANIFEST_INCOMPLETE: 409,
  PROCESS_COUNT_MISMATCH: 409,
  BATCH_INDEX_OUT_OF_RANGE: 400
};

export function statusForRepositoryCode(code) {
  return REPOSITORY_STATUS[code] ?? 500;
}
