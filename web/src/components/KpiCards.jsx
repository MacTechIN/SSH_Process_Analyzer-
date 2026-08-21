export function KpiCards({ kpis }) {
  const cards = [
    { label: "작업 중인 사용자", value: kpis.activeOwners },
    { label: "실행 중인 작업", value: kpis.runningTasks },
    { label: "장시간 실행", value: kpis.longRunning, warn: kpis.longRunning > 0 },
    { label: "작업 유형 미분류", value: kpis.unclassified, warn: kpis.unclassified > 0 },
    { label: "최근 수집 없는 서버", value: kpis.degradedHosts, warn: kpis.degradedHosts > 0 }
  ];

  return (
    <div className="kpi-row">
      {cards.map((card) => (
        <div key={card.label} className={`kpi${card.warn ? " kpi-warn" : ""}`}>
          <span className="kpi-value">{card.value}</span>
          <span className="kpi-label">{card.label}</span>
        </div>
      ))}
    </div>
  );
}
