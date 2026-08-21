export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "-";
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}일 ${hours}시간`;
  }
  if (hours > 0) {
    return `${hours}시간 ${minutes}분`;
  }
  if (minutes > 0) {
    return `${minutes}분`;
  }
  return `${Math.floor(seconds)}초`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}%` : "-";
}

export function formatTimestamp(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) {
    return "-";
  }
  return new Date(iso).toLocaleString("ko-KR", { hour12: false });
}

export function formatRelative(iso, nowMs) {
  if (!iso || Number.isNaN(Date.parse(iso))) {
    return "-";
  }
  return `${formatDuration((nowMs - Date.parse(iso)) / 1000)} 전`;
}
