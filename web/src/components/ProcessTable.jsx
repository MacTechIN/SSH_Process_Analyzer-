import { formatBytes, formatDuration, formatPercent, formatTimestamp } from "../lib/format.js";
import { HostStateBadge, RowFlags } from "./StatusBadge.jsx";

export function ProcessTable({ page, onSelect, selectedKey, onPageChange }) {
  if (page.total === 0) {
    return <p className="empty">조건에 맞는 작업이 없습니다.</p>;
  }

  return (
    <>
      <table className="process-table">
        <thead>
          <tr>
            <th>담당자</th>
            <th>작업 요약</th>
            <th>작업 유형</th>
            <th>서버</th>
            <th>시작 시각</th>
            <th>실행 시간</th>
            <th>CPU</th>
            <th>메모리</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row) => (
            <tr
              key={`${row.hostId}/${row.processKey}`}
              className={selectedKey === row.processKey ? "selected" : undefined}
              onClick={() => onSelect(row)}
            >
              <td>{row.ownerName}</td>
              <td className="command" title={row.commandSummary}>
                {row.commandSummary}
              </td>
              <td>{row.taskLabel}</td>
              <td>{row.hostId}</td>
              <td>{formatTimestamp(row.startedAt)}</td>
              <td>{formatDuration(row.runtimeSeconds)}</td>
              <td>{formatPercent(row.cpuPercent)}</td>
              <td>{formatBytes(row.memoryBytes)}</td>
              <td>
                <HostStateBadge state={row.hostState} />
                <RowFlags row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pagination">
        <button type="button" disabled={page.page <= 1} onClick={() => onPageChange(page.page - 1)}>
          이전
        </button>
        <span>
          {page.page} / {page.pageCount} 페이지 · 총 {page.total}건
        </span>
        <button type="button" disabled={page.page >= page.pageCount} onClick={() => onPageChange(page.page + 1)}>
          다음
        </button>
      </div>
    </>
  );
}
