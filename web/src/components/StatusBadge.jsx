const HOST_LABELS = {
  online: "정상",
  stale: "지연",
  warn: "경고",
  offline: "오프라인",
  unknown: "수집 없음"
};

export function HostStateBadge({ state }) {
  return <span className={`badge host-${state}`}>{HOST_LABELS[state] ?? state}</span>;
}

export function RowFlags({ row }) {
  return (
    <span className="flags">
      {row.longRunning ? <span className="badge flag-long">장시간</span> : null}
      {row.duplicateSuspected ? <span className="badge flag-duplicate">중복 의심</span> : null}
      {row.unclassified ? <span className="badge flag-unclassified">미분류</span> : null}
    </span>
  );
}
