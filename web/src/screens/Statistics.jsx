import { useMemo } from "react";
import { BarList } from "../components/BarList.jsx";
import { formatBytes, formatDuration, formatPercent } from "../lib/format.js";
import {
  hostLoad,
  hourlyStartTrend,
  longestRunning,
  processesPerOwner,
  taskTypeShare
} from "../lib/statistics.js";

export function Statistics({ rows, nowMs }) {
  const owners = useMemo(() => processesPerOwner(rows), [rows]);
  const tasks = useMemo(() => taskTypeShare(rows), [rows]);
  const trend = useMemo(() => hourlyStartTrend(rows, nowMs), [rows, nowMs]);
  const load = useMemo(() => hostLoad(rows), [rows]);
  const longest = useMemo(() => longestRunning(rows, 10), [rows]);

  return (
    <div className="screen stats-grid">
      <BarList title="사용자별 현재 실행 작업 수" entries={owners} />
      <BarList
        title="작업 유형별 점유율"
        entries={tasks}
        format={(entry) => `${entry.count}건 · ${formatPercent(entry.share, 0)}`}
      />
      <BarList
        title="시간대별 시작 작업 수 (최근 24시간)"
        entries={trend.map((bucket) => ({
          key: `${new Date(bucket.start).getHours()}시`,
          count: bucket.count
        }))}
      />
      <BarList
        title="서버별 CPU 부하"
        entries={load.map((entry) => ({ ...entry, count: Math.round(entry.cpuPercent) }))}
        format={(entry) => `${formatPercent(entry.cpuPercent, 0)} · ${formatBytes(entry.memoryBytes)}`}
      />
      <section className="panel wide">
        <h3>장시간 실행 작업 Top 10</h3>
        {longest.length === 0 ? (
          <p className="empty">데이터 없음</p>
        ) : (
          <table className="process-table">
            <thead>
              <tr>
                <th>담당자</th>
                <th>작업</th>
                <th>서버</th>
                <th>실행 시간</th>
                <th>CPU</th>
              </tr>
            </thead>
            <tbody>
              {longest.map((row) => (
                <tr key={`${row.hostId}/${row.processKey}`}>
                  <td>{row.ownerName}</td>
                  <td className="command">{row.commandSummary}</td>
                  <td>{row.hostId}</td>
                  <td>{formatDuration(row.runtimeSeconds)}</td>
                  <td>{formatPercent(row.cpuPercent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
