import { RUNTIME_BUCKETS, STATUS_FILTERS, distinctValues } from "../lib/process-view.js";

export function Filters({ rows, filters, onChange }) {
  const update = (patch) => onChange({ ...filters, ...patch });

  return (
    <div className="filters">
      <input
        type="search"
        placeholder="사용자, 작업, 서버, 명령 검색"
        value={filters.search ?? ""}
        onChange={(event) => update({ search: event.target.value })}
      />
      <select value={filters.ownerName ?? ""} onChange={(event) => update({ ownerName: event.target.value })}>
        <option value="">모든 사용자</option>
        {distinctValues(rows, "ownerName").map((owner) => (
          <option key={owner} value={owner}>
            {owner}
          </option>
        ))}
      </select>
      <select value={filters.taskType ?? ""} onChange={(event) => update({ taskType: event.target.value })}>
        <option value="">모든 작업 유형</option>
        {distinctValues(rows, "taskLabel").map((task) => (
          <option key={task} value={task}>
            {task}
          </option>
        ))}
      </select>
      <select value={filters.hostId ?? ""} onChange={(event) => update({ hostId: event.target.value })}>
        <option value="">모든 서버</option>
        {distinctValues(rows, "hostId").map((host) => (
          <option key={host} value={host}>
            {host}
          </option>
        ))}
      </select>
      <select value={filters.status ?? ""} onChange={(event) => update({ status: event.target.value })}>
        <option value="">모든 상태</option>
        {Object.entries(STATUS_FILTERS).map(([value, entry]) => (
          <option key={value} value={value}>
            {entry.label}
          </option>
        ))}
      </select>
      <select value={filters.runtime ?? ""} onChange={(event) => update({ runtime: event.target.value })}>
        <option value="">모든 실행 시간</option>
        {Object.entries(RUNTIME_BUCKETS).map(([value, entry]) => (
          <option key={value} value={value}>
            {entry.label}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => onChange({})}>
        초기화
      </button>
    </div>
  );
}
