import { historyApiBaseUrl } from "../firebase.js";

export const historyApiConfigured = Boolean(historyApiBaseUrl);

export async function fetchSnapshotHistory({ user, tenantId, hostId, cursor, limit = 25 }) {
  if (!historyApiConfigured) {
    throw new Error("HISTORY_API_NOT_CONFIGURED");
  }
  const url = new URL(`/v1/tenants/${tenantId}/hosts/${hostId}/snapshots`, historyApiBaseUrl);
  url.searchParams.set("limit", String(limit));
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${await user.getIdToken()}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.code ?? "HISTORY_REQUEST_FAILED");
    error.code = body.code ?? "HISTORY_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return body;
}
