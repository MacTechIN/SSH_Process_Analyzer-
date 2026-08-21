import { useEffect, useState } from "react";
import { useAuth } from "./data/useAuth.js";
import { useTenantData } from "./data/useTenantData.js";
import { defaultTenantId, firebaseConfigured, signIn, signOutUser } from "./firebase.js";
import { CurrentWork } from "./screens/CurrentWork.jsx";
import { Exceptions } from "./screens/Exceptions.jsx";
import { Servers } from "./screens/Servers.jsx";
import { Settings } from "./screens/Settings.jsx";
import { Statistics } from "./screens/Statistics.jsx";
import { formatRelative } from "./lib/format.js";

const SCREENS = [
  { id: "current", label: "현재 작업 현황" },
  { id: "stats", label: "통계" },
  { id: "servers", label: "서버 상태" },
  { id: "exceptions", label: "예외 작업" },
  { id: "settings", label: "설정" }
];

function Shell({ children, header }) {
  return (
    <div className="shell">
      <header className="top">{header}</header>
      <main>{children}</main>
    </div>
  );
}

export default function App() {
  const { status: authStatus, user } = useAuth();
  const [screen, setScreen] = useState("current");
  const [tenantId, setTenantId] = useState(
    () => localStorage.getItem("tenantId") ?? defaultTenantId
  );
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(
    () => Number(localStorage.getItem("refreshIntervalSeconds") ?? 0)
  );

  useEffect(() => {
    localStorage.setItem("tenantId", tenantId);
  }, [tenantId]);
  useEffect(() => {
    localStorage.setItem("refreshIntervalSeconds", String(refreshIntervalSeconds));
  }, [refreshIntervalSeconds]);

  const data = useTenantData({ user, tenantId, refreshIntervalSeconds });

  if (!firebaseConfigured) {
    return (
      <Shell header={<h1>SSH Process Analyzer</h1>}>
        <section className="panel">
          <h3>Firebase 설정이 없습니다</h3>
          <p>
            `web/.env`에 `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
            `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`를 채우고 다시 빌드하세요.
          </p>
        </section>
      </Shell>
    );
  }

  if (authStatus === "loading") {
    return <Shell header={<h1>SSH Process Analyzer</h1>}>로그인 상태 확인 중…</Shell>;
  }

  if (authStatus === "signed-out") {
    return (
      <Shell header={<h1>SSH Process Analyzer</h1>}>
        <section className="panel">
          <h3>로그인이 필요합니다</h3>
          <p>조회 권한은 tenant membership으로 결정됩니다.</p>
          <button type="button" onClick={signIn}>
            Google 계정으로 로그인
          </button>
        </section>
      </Shell>
    );
  }

  const header = (
    <>
      <h1>SSH Process Analyzer</h1>
      <nav>
        {SCREENS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={screen === entry.id ? "active" : undefined}
            onClick={() => setScreen(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="session">
        {data.loadedAt ? <span className="hint">{formatRelative(new Date(data.loadedAt).toISOString(), Date.now())} 조회</span> : null}
        <button type="button" onClick={data.reload} disabled={data.status === "loading"}>
          {data.status === "loading" ? "조회 중" : "새로고침"}
        </button>
        <span className="hint">{user.email}</span>
        <button type="button" onClick={signOutUser}>
          로그아웃
        </button>
      </div>
    </>
  );

  if (!tenantId) {
    return (
      <Shell header={header}>
        <section className="panel">
          <h3>Tenant를 지정하세요</h3>
          <p>설정 화면에서 조회할 tenant ID를 입력합니다.</p>
          <button type="button" onClick={() => setScreen("settings")}>
            설정으로 이동
          </button>
        </section>
      </Shell>
    );
  }

  if (data.status === "forbidden") {
    return (
      <Shell header={header}>
        <section className="panel">
          <h3>조회 권한이 없습니다</h3>
          <p>
            `{tenantId}` tenant에 membership이 없습니다. 관리자가 `tenants/{tenantId}/memberships/{user.uid}`
            문서를 만들어야 조회할 수 있습니다.
          </p>
        </section>
      </Shell>
    );
  }

  if (data.status === "error") {
    return (
      <Shell header={header}>
        <section className="panel">
          <h3>조회 중 오류가 발생했습니다</h3>
          <p className="warn-text">{data.error}</p>
          <button type="button" onClick={data.reload}>
            다시 시도
          </button>
        </section>
      </Shell>
    );
  }

  if (data.status === "loading" && data.rows.length === 0) {
    return <Shell header={header}>조회 중…</Shell>;
  }

  if (data.status === "ready" && data.rows.length === 0 && Object.keys(data.hosts).length === 0) {
    return (
      <Shell header={header}>
        <section className="panel">
          <h3>수집된 데이터가 없습니다</h3>
          <p>collector가 아직 snapshot을 publish하지 않았습니다.</p>
        </section>
      </Shell>
    );
  }

  const screens = {
    current: <CurrentWork rows={data.rows} hosts={data.hosts} nowMs={data.nowMs} />,
    stats: <Statistics rows={data.rows} nowMs={data.nowMs} />,
    servers: (
      <Servers
        rows={data.rows}
        hosts={data.hosts}
        nowMs={data.nowMs}
        user={user}
        tenantId={tenantId}
        role={data.role}
      />
    ),
    exceptions: <Exceptions rows={data.rows} />,
    settings: (
      <Settings
        tenantId={tenantId}
        onTenantIdChange={setTenantId}
        refreshIntervalSeconds={refreshIntervalSeconds}
        onRefreshChange={setRefreshIntervalSeconds}
        role={data.role}
        loadedAt={data.loadedAt}
        user={user}
      />
    )
  };

  return <Shell header={header}>{screens[screen]}</Shell>;
}
