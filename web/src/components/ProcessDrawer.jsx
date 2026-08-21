import { formatBytes, formatDuration, formatPercent, formatRelative, formatTimestamp } from "../lib/format.js";
import { HostStateBadge } from "./StatusBadge.jsx";

export function ProcessDrawer({ row, nowMs, onClose }) {
  if (!row) {
    return null;
  }

  const fields = [
    ["사용자 이름", row.ownerName],
    ["작업 유형", row.taskLabel],
    ["서버", row.hostId],
    ["PID", row.pid],
    ["시작 시각", formatTimestamp(row.startedAt)],
    ["실행 시간", formatDuration(row.runtimeSeconds)],
    ["CPU", formatPercent(row.cpuPercent)],
    ["메모리", formatBytes(row.memoryBytes)],
    ["작업 경로", row.workingDirectory ?? "-"],
    ["중복 실행 의심", row.duplicateSuspected ? "예" : "아니오"],
    ["최근 수집 시각", formatRelative(row.hostIngestFailure?.at ?? null, nowMs)]
  ];

  return (
    <aside className="drawer">
      <header>
        <h3>작업 상세</h3>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </header>

      <dl>
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <h4>마스킹된 실행 명령</h4>
      <p className="command-block">{row.commandSummary}</p>
      <p className="note">
        raw command 전체와 환경 변수는 수집하지도 저장하지도 않습니다. 인자는 마스킹과 allowlist를 거친
        값만 표시됩니다.
      </p>

      <h4>서버 상태</h4>
      <p>
        <HostStateBadge state={row.hostState} /> 마지막 정상 publish{" "}
        {row.hostSecondsSincePublish === null ? "기록 없음" : `${formatDuration(row.hostSecondsSincePublish)} 전`}
      </p>
      {row.hostIngestFailure ? (
        <p className="warn-text">
          API 수신 후 실패: {row.hostIngestFailure.category} · {formatTimestamp(row.hostIngestFailure.at)}
        </p>
      ) : null}
    </aside>
  );
}
