import { historyApiConfigured } from "../data/historyApi.js";
import { formatTimestamp } from "../lib/format.js";

export function Settings({ tenantId, onTenantIdChange, refreshIntervalSeconds, onRefreshChange, role, loadedAt, user }) {
  return (
    <div className="screen">
      <section className="panel">
        <h3>조회 설정</h3>
        <label>
          Tenant ID
          <input value={tenantId} onChange={(event) => onTenantIdChange(event.target.value.trim())} />
        </label>
        <label>
          자동 새로고침
          <select
            value={String(refreshIntervalSeconds)}
            onChange={(event) => onRefreshChange(Number(event.target.value))}
          >
            <option value="0">사용 안 함</option>
            <option value="60">1분</option>
            <option value="300">5분</option>
            <option value="900">15분</option>
          </select>
        </label>
        <p className="hint">
          조회는 요청할 때만 Firestore를 읽습니다. 자동 새로고침 간격이 짧을수록 무료 할당량을 빨리 씁니다.
        </p>
      </section>

      <section className="panel">
        <h3>세션</h3>
        <dl>
          <div>
            <dt>계정</dt>
            <dd>{user?.email ?? "-"}</dd>
          </div>
          <div>
            <dt>role</dt>
            <dd>{role ?? "-"}</dd>
          </div>
          <div>
            <dt>마지막 조회</dt>
            <dd>{loadedAt ? formatTimestamp(new Date(loadedAt).toISOString()) : "-"}</dd>
          </div>
          <div>
            <dt>History API</dt>
            <dd>{historyApiConfigured ? "설정됨" : "미설정"}</dd>
          </div>
        </dl>
        <p className="hint">
          웹앱은 조회 전용입니다. 모든 쓰기는 Firestore Rules에서 차단되어 있습니다.
        </p>
      </section>
    </div>
  );
}
