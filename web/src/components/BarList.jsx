export function BarList({ title, entries, format = (entry) => entry.count, empty = "데이터 없음" }) {
  const max = Math.max(1, ...entries.map((entry) => entry.count));

  return (
    <section className="panel">
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ul className="bar-list">
          {entries.map((entry) => (
            <li key={entry.key}>
              <span className="bar-label" title={entry.key}>
                {entry.key}
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(entry.count / max) * 100}%` }} />
              </span>
              <span className="bar-value">{format(entry)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
