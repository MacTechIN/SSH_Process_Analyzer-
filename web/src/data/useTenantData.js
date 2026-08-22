import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs, limit, query } from "firebase/firestore";
import { db } from "../firebase.js";
import { HEALTH } from "../lib/policy.js";
import { buildRows } from "../lib/process-view.js";

const MAX_PROCESSES_PER_HOST = 2000;

// Reads are pulled on demand rather than streamed. A live subscription would re-read every
// process document on each collector push, which burns through the Firestore free tier.
export function useTenantData({ user, tenantId, refreshIntervalSeconds, thresholds = HEALTH }) {
  const [state, setState] = useState({ status: "idle", hosts: {}, processes: [], error: null });
  const [loadedAt, setLoadedAt] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!user || !tenantId) {
      return;
    }
    setState((previous) => ({ ...previous, status: "loading", error: null }));
    try {
      const membership = await getDoc(doc(db, `tenants/${tenantId}/memberships/${user.uid}`));
      if (!membership.exists()) {
        setState({ status: "forbidden", hosts: {}, processes: [], error: null });
        return;
      }

      const hostDocs = await getDocs(collection(db, `tenants/${tenantId}/hosts`));
      const hosts = {};
      const processes = [];

      for (const hostDoc of hostDocs.docs) {
        const host = { hostId: hostDoc.id, ...hostDoc.data() };
        hosts[hostDoc.id] = host;
        if (!host.publishedGeneration) {
          continue;
        }
        const processDocs = await getDocs(
          query(
            collection(
              db,
              `tenants/${tenantId}/hosts/${hostDoc.id}/generations/${host.publishedGeneration}/processes`
            ),
            limit(MAX_PROCESSES_PER_HOST)
          )
        );
        for (const processDoc of processDocs.docs) {
          processes.push({ hostId: hostDoc.id, ...processDoc.data() });
        }
      }

      setState({
        status: "ready",
        hosts,
        processes,
        role: membership.data()?.role ?? "viewer",
        error: null
      });
      setLoadedAt(Date.now());
      setNowMs(Date.now());
    } catch (error) {
      if (error?.code === "permission-denied") {
        setState({ status: "forbidden", hosts: {}, processes: [], error: null });
        return;
      }
      setState({ status: "error", hosts: {}, processes: [], error: error.code ?? error.message });
    }
  }, [user, tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!refreshIntervalSeconds) {
      return undefined;
    }
    const timer = setInterval(load, refreshIntervalSeconds * 1000);
    return () => clearInterval(timer);
  }, [load, refreshIntervalSeconds]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(
    () => buildRows({ processes: state.processes, hosts: state.hosts, nowMs, thresholds }),
    [state.processes, state.hosts, nowMs, thresholds]
  );

  return { ...state, rows, nowMs, loadedAt, thresholds, reload: load };
}
