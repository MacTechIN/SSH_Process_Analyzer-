import { reject } from "./api-error.js";

const SNAPSHOT_FIELDS = new Set(["schemaVersion", "snapshotId", "capturedAt", "processes"]);
const PROCESS_REQUIRED = [
  "processKey",
  "bootId",
  "pid",
  "startTicks",
  "startedAt",
  "ownerName",
  "executable",
  "classificationStatus",
  "cpuPercent",
  "memoryBytes"
];
const PROCESS_FIELDS = new Set([...PROCESS_REQUIRED, "allowedArgs", "workingDirectory", "taskType"]);
const CLASSIFICATION_STATUS = new Set(["classified", "unclassified"]);

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROCESS_KEY_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

const MAX_EXECUTABLE_LENGTH = 512;
const MAX_ALLOWED_ARGS = 16;
const MAX_ALLOWED_ARG_LENGTH = 256;
const MAX_WORKING_DIRECTORY_LENGTH = 1024;
const MAX_TASK_TYPE_LENGTH = 128;

function invalid(detail) {
  reject(400, "SCHEMA_INVALID", detail);
}

function requireObject(value, detail) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(detail);
  }
}

function requireRfc3339(value, detail) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    invalid(detail);
  }
}

function requireInteger(value, minimum, detail) {
  if (!Number.isInteger(value) || value < minimum) {
    invalid(detail);
  }
}

function requireString(value, pattern, detail) {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid(detail);
  }
}

function validateProcess(process, index) {
  requireObject(process, `processes[${index}] must be an object`);
  for (const field of Object.keys(process)) {
    if (!PROCESS_FIELDS.has(field)) {
      invalid(`processes[${index}].${field} is not part of snapshot v1`);
    }
  }
  for (const field of PROCESS_REQUIRED) {
    if (process[field] === undefined) {
      invalid(`processes[${index}].${field} is required`);
    }
  }

  requireString(process.processKey, PROCESS_KEY_PATTERN, `processes[${index}].processKey must be sha256 hex`);
  requireString(process.bootId, UUID_PATTERN, `processes[${index}].bootId must be a lowercase uuid`);
  requireInteger(process.pid, 1, `processes[${index}].pid must be a positive integer`);
  requireInteger(process.startTicks, 0, `processes[${index}].startTicks must be a non-negative integer`);
  requireRfc3339(process.startedAt, `processes[${index}].startedAt must be an RFC 3339 timestamp`);
  requireString(process.ownerName, OWNER_NAME_PATTERN, `processes[${index}].ownerName is out of range`);

  if (typeof process.executable !== "string" || process.executable.length < 1) {
    invalid(`processes[${index}].executable is required`);
  }
  if (process.executable.length > MAX_EXECUTABLE_LENGTH) {
    invalid(`processes[${index}].executable exceeds ${MAX_EXECUTABLE_LENGTH} characters`);
  }

  if (process.allowedArgs !== undefined) {
    if (!Array.isArray(process.allowedArgs) || process.allowedArgs.length > MAX_ALLOWED_ARGS) {
      invalid(`processes[${index}].allowedArgs allows at most ${MAX_ALLOWED_ARGS} items`);
    }
    for (const arg of process.allowedArgs) {
      if (typeof arg !== "string" || arg.length > MAX_ALLOWED_ARG_LENGTH) {
        invalid(`processes[${index}].allowedArgs items exceed ${MAX_ALLOWED_ARG_LENGTH} characters`);
      }
    }
  }
  if (process.workingDirectory !== undefined) {
    if (typeof process.workingDirectory !== "string" || process.workingDirectory.length > MAX_WORKING_DIRECTORY_LENGTH) {
      invalid(`processes[${index}].workingDirectory exceeds ${MAX_WORKING_DIRECTORY_LENGTH} characters`);
    }
  }
  if (process.taskType !== undefined && process.taskType !== null) {
    if (typeof process.taskType !== "string" || process.taskType.length > MAX_TASK_TYPE_LENGTH) {
      invalid(`processes[${index}].taskType exceeds ${MAX_TASK_TYPE_LENGTH} characters`);
    }
  }
  if (!CLASSIFICATION_STATUS.has(process.classificationStatus)) {
    invalid(`processes[${index}].classificationStatus must be classified or unclassified`);
  }
  if (typeof process.cpuPercent !== "number" || !Number.isFinite(process.cpuPercent) || process.cpuPercent < 0) {
    invalid(`processes[${index}].cpuPercent must be a non-negative number`);
  }
  requireInteger(process.memoryBytes, 0, `processes[${index}].memoryBytes must be a non-negative integer`);
}

export function validateSnapshotV1(body) {
  requireObject(body, "snapshot body must be a JSON object");
  for (const field of Object.keys(body)) {
    if (!SNAPSHOT_FIELDS.has(field)) {
      invalid(`${field} is not part of snapshot v1`);
    }
  }
  if (body.schemaVersion !== 1) {
    invalid("schemaVersion must be 1");
  }
  requireString(body.snapshotId, UUID_V4_PATTERN, "snapshotId must be a lowercase UUIDv4");
  requireRfc3339(body.capturedAt, "capturedAt must be an RFC 3339 timestamp");
  if (!Array.isArray(body.processes)) {
    invalid("processes must be an array");
  }

  const seen = new Set();
  body.processes.forEach((process, index) => {
    validateProcess(process, index);
    if (seen.has(process.processKey)) {
      invalid(`processes[${index}].processKey is duplicated within the snapshot`);
    }
    seen.add(process.processKey);
  });

  return body;
}
