import { useMemo } from "react";
import { formatDuration, formatPercent } from "../lib/format.js";
import { HostStateBadge } from "../components/StatusBadge.jsx";
import { exceptionBuckets } from "../lib/statistics.js";

const SECTIONS = [
  { key: "longRunning", title: "장시간 실행", hint: "24시간 이상 실행 중인 작업" },
  { key: "duplicate", title: "중복 실행 의심", hint: "같은 서버에서 동일한 사용자, 작업 유형, 실행 파일이 2건 이상" },
  { key: "unclassified", title: "작업 유형 미분류", hint: "allowlist 규칙으로 분류하지 못한 작업" },
  { key: "degradedHost", title: "최근 수집이 없는 서버의 작업", hint: "마지막 정상 publish 이후 2분이 지난 서버" }
];

export function Exceptions({ rows }) {
  const buckets = useMemo(() => exceptionBuckets(rows), [rows]);

  return (
    <div className="screen">
      {SECTIONS.map((section) => (
        <section className="panel wide" key={section.key}>
          <h3>
            {section.title} <span className="count">{buckets[section.key].length}건</span>
          </h3>
          <p className="hint">{section.hint}</p>
          {buckets[section.key].length === 0 ? (
            <p className="empty">해당 없음</p>
          ) : (
            <table className="process-table">
              <thead>
                <tr>
                  <th>담당자</th>
                  <th>작업</th>
                  <th>서버</th>
                  <th>실행 시간</th>
                  <th>CPU</th>
                  <th>서버 상태</th>
                </tr>
              </thead>
              <tbody>
                {buckets[section.key].slice(0, 20).map((row) => (
                  <tr key={`${row.hostId}/${row.processKey}`}>
                    <td>{row.ownerName}</td>
                    <td className="command">{row.commandSummary}</td>
                    <td>{row.hostId}</td>
                    <td>{formatDuration(row.runtimeSeconds)}</td>
                    <td>{formatPercent(row.cpuPercent)}</td>
                    <td>
                      <HostStateBadge state={row.hostState} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}
