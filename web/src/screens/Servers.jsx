import { useState } from "react";
import { HostStateBadge } from "../components/StatusBadge.jsx";
import { fetchSnapshotHistory, historyApiConfigured } from "../data/historyApi.js";
import { formatBytes, formatDuration, formatPercent, formatTimestamp } from "../lib/format.js";
import { hostHealth } from "../lib/status.js";
import { hostLoad } from "../lib/statistics.js";

function HistoryPanel({ user, tenantId, hostId }) {
  const [state, setState] = useState({ status: "idle", snapshots: [], cursor: null, error: null });

  if (!historyApiConfigured) {
    return (
      <section className="panel">
        <h4>Snapshot History</h4>
        <p className="hint">
          `VITE_HISTORY_API_BASE_URL`이 설정되지 않았습니다. history는 Firestore 직접 조회가 금지되어 있어
          서버 조회 API가 있어야 볼 수 있습니다.
        </p>
      </section>
    );
  }

  const load = async (cursor) => {
    setState((previous) => ({ ...previous, status: "loading", error: null }));
    try {
      const result = await fetchSnapshotHistory({ user, tenantId, hostId, cursor, limit: 25 });
      setState({
        status: "ready",
        snapshots: cursor ? [...state.snapshots, ...result.snapshots] : result.snapshots,
        cursor: result.nextCursor,
        error: null
      });
    } catch (error) {
      setState((previous) => ({ ...previous, status: "error", error: error.code ?? "요청 실패" }));
    }
  };

  return (
    <section className="panel">
      <h4>Snapshot History</h4>
      <button type="button" onClick={() => load(null)} disabled={state.status === "loading"}>
        {state.status === "loading" ? "불러오는 중" : "불러오기"}
      </button>
      {state.error ? <p className="warn-text">{state.error}</p> : null}
      {state.snapshots.length > 0 ? (
        <>
          <table className="process-table">
            <thead>
              <tr>
                <th>수집 시각</th>
                <th>process 수</th>
                <th>publish</th>
              </tr>
            </thead>
            <tbody>
              {state.snapshots.map((snapshot) => (
                <tr key={snapshot.snapshotId}>
                  <td>{formatTimestamp(snapshot.capturedAt)}</td>
                  <td>{snapshot.processCount}</td>
                  <td>{snapshot.published ? "반영" : "보관만"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.cursor ? (
            <button type="button" onClick={() => load(state.cursor)}>
              더 보기
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function Servers({ rows, hosts, nowMs, user, tenantId, role, thresholds }) {
  const [selected, setSelected] = useState(null);
  const load = Object.fromEntries(hostLoad(rows).map((entry) => [entry.key, entry]));
  const hostIds = Object.keys(hosts).sort();
  const selectedHost = selected ? hosts[selected] : null;

  return (
    <div className="screen">
      <section className="panel wide">
        <h3>서버 상태</h3>
        {hostIds.length === 0 ? (
          <p className="empty">등록된 서버가 없습니다.</p>
        ) : (
          <table className="process-table">
            <thead>
              <tr>
                <th>서버</th>
                <th>상태</th>
                <th>마지막 정상 publish</th>
                <th>API 수신 후 실패</th>
                <th>작업 수</th>
                <th>CPU 합계</th>
                <th>메모리 합계</th>
              </tr>
            </thead>
            <tbody>
              {hostIds.map((hostId) => {
                const health = hostHealth(hosts[hostId], nowMs, thresholds);
                const hostLoadEntry = load[hostId];
                return (
                  <tr
                    key={hostId}
                    onClick={() => setSelected(hostId)}
                    className={selected === hostId ? "selected" : undefined}
                  >
                    <td>{hostId}</td>
                    <td>
                      <HostStateBadge state={health.state} />
                    </td>
                    <td>
                      {health.secondsSincePublish === null
                        ? "기록 없음"
                        : `${formatDuration(health.secondsSincePublish)} 전`}
                    </td>
                    <td>
                      {health.ingestFailure ? (
                        <span className="warn-text">{health.ingestFailure.category}</span>
                      ) : (
                        "없음"
                      )}
                    </td>
                    <td>{hostLoadEntry?.count ?? 0}</td>
                    <td>{formatPercent(hostLoadEntry?.cpuPercent ?? 0, 0)}</td>
                    <td>{formatBytes(hostLoadEntry?.memoryBytes ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {selectedHost ? (
        <>
          <section className="panel">
            <h4>{selected} 상세</h4>
            <dl>
              <div>
                <dt>현재 generation</dt>
                <dd>{selectedHost.publishedGeneration ?? "없음"}</dd>
              </div>
              <div>
                <dt>수집 시각</dt>
                <dd>{formatTimestamp(selectedHost.publishedCapturedAt)}</dd>
              </div>
              <div>
                <dt>마지막 시도</dt>
                <dd>{formatTimestamp(selectedHost.lastAttemptAt)}</dd>
              </div>
              <div>
                <dt>마지막 결과</dt>
                <dd>{selectedHost.lastOutcome ?? "기록 없음"}</dd>
              </div>
              {role === "viewer" ? null : (
                <div>
                  <dt>실패 분류</dt>
                  <dd>{selectedHost.lastErrorCategory ?? "없음"}</dd>
                </div>
              )}
            </dl>
            <p className="hint">
              agent 등록 정보와 quarantine 상태는 브라우저에서 읽을 수 없습니다. 운영 CLI로 확인합니다.
            </p>
          </section>
          <HistoryPanel user={user} tenantId={tenantId} hostId={selected} />
        </>
      ) : null}
    </div>
  );
}
