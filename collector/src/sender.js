import { createNonce, signingTimestamp } from "./signing.js";

const RETRYABLE_STATUS = new Set([408, 425, 429]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

export function backoffDelayMs({ attempt, baseBackoffMs, maxBackoffMs, random }) {
  const ceiling = Math.min(baseBackoffMs * 2 ** (attempt - 1), maxBackoffMs);
  return Math.round(ceiling * random());
}

export function createSender({
  config,
  signer,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  now = () => new Date()
}) {
  return {
    async send({ wireBody, contentEncoding, snapshotId }) {
      const url = new URL("/v1/snapshots", config.apiBaseUrl);
      let lastError = null;

      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        const headers = {
          "content-type": "application/json",
          ...(contentEncoding === "gzip" ? { "content-encoding": "gzip" } : {}),
          ...signer.sign({ wireBody, timestamp: signingTimestamp(now()), nonce: createNonce() })
        };

        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers,
            body: wireBody,
            signal: AbortSignal.timeout(config.requestTimeoutMs)
          });
          const payload = await response.json().catch(() => ({}));
          if (response.ok) {
            return { ok: true, status: response.status, attempts: attempt, payload, snapshotId };
          }
          if (!isRetryableStatus(response.status)) {
            return {
              ok: false,
              status: response.status,
              attempts: attempt,
              retryable: false,
              code: payload.code,
              snapshotId
            };
          }
          lastError = { status: response.status, code: payload.code };
        } catch (error) {
          lastError = { error: error.name };
        }

        if (attempt < config.maxAttempts) {
          await sleep(backoffDelayMs({ attempt, ...config, random }));
        }
      }

      return {
        ok: false,
        attempts: config.maxAttempts,
        retryable: true,
        status: lastError?.status ?? null,
        code: lastError?.code ?? lastError?.error ?? "PUSH_FAILED",
        snapshotId
      };
    }
  };
}
