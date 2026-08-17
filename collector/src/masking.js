export const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERN =
  /(pass|pwd|secret|token|credential|auth|session|cookie|private|apikey|api[-_]?key|access[-_]?key)/i;
const PEM_PATTERN = /-----BEGIN[A-Z ]*-----/;
const URI_CREDENTIAL_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@(.*)$/i;
const OPAQUE_SECRET_PATTERN = /^[A-Za-z0-9+/_=-]{32,}$/;
const FLAG_PATTERN = /^--?([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const ASSIGNMENT_PATTERN = /^(--?[A-Za-z0-9][A-Za-z0-9._-]*)=(.*)$/s;
const PATH_LIKE_PATTERN = /^[/~.]/;

function truncate(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function maskValue(value) {
  if (PEM_PATTERN.test(value)) {
    return REDACTED;
  }
  const uri = URI_CREDENTIAL_PATTERN.exec(value);
  if (uri) {
    return `${uri[1]}${REDACTED}@${uri[3]}`;
  }
  if (!PATH_LIKE_PATTERN.test(value) && OPAQUE_SECRET_PATTERN.test(value)) {
    return REDACTED;
  }
  return value;
}

export function maskArgs(args, { maxArgs, maxLength }) {
  const masked = [];
  let redactNext = false;

  for (const raw of args) {
    if (masked.length === maxArgs) {
      break;
    }
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    if (redactNext) {
      masked.push(REDACTED);
      redactNext = false;
      continue;
    }

    const assignment = ASSIGNMENT_PATTERN.exec(raw);
    if (assignment) {
      const [, key, value] = assignment;
      masked.push(
        SENSITIVE_KEY_PATTERN.test(key)
          ? `${key}=${REDACTED}`
          : truncate(`${key}=${maskValue(value)}`, maxLength)
      );
      continue;
    }

    const flag = FLAG_PATTERN.exec(raw);
    if (flag && SENSITIVE_KEY_PATTERN.test(flag[1])) {
      masked.push(raw);
      redactNext = true;
      continue;
    }

    masked.push(truncate(maskValue(raw), maxLength));
  }

  return masked;
}

export function maskExecutable(executable, maxLength) {
  if (PEM_PATTERN.test(executable)) {
    return REDACTED;
  }
  return truncate(executable, maxLength);
}
