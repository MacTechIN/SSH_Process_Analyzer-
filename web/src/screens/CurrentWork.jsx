import { useMemo, useState } from "react";
import { Filters } from "../components/Filters.jsx";
import { KpiCards } from "../components/KpiCards.jsx";
import { ProcessDrawer } from "../components/ProcessDrawer.jsx";
import { ProcessTable } from "../components/ProcessTable.jsx";
import { computeKpis, filterRows, paginate, sortRows } from "../lib/process-view.js";

export function CurrentWork({ rows, hosts, nowMs }) {
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);

  const sorted = useMemo(() => sortRows(filterRows(rows, filters)), [rows, filters]);
  const kpis = useMemo(() => computeKpis(rows, hosts, nowMs), [rows, hosts, nowMs]);
  const pageData = paginate(sorted, { page, pageSize: 25 });

  return (
    <div className="screen">
      <KpiCards kpis={kpis} />
      <Filters
        rows={rows}
        filters={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
        }}
      />
      <div className="with-drawer">
        <div className="table-area">
          <ProcessTable
            page={pageData}
            selectedKey={selected?.processKey}
            onSelect={setSelected}
            onPageChange={setPage}
          />
        </div>
        <ProcessDrawer row={selected} nowMs={nowMs} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
}
