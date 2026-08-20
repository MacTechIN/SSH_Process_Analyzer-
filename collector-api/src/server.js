import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { ApiError } from "./api-error.js";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CURRENT_PATH_PATTERN = /^\/v1\/tenants\/([A-Za-z0-9_-]{1,128})\/hosts\/([A-Za-z0-9_-]{1,128})\/current$/;
const HISTORY_PATH_PATTERN = /^\/v1\/tenants\/([A-Za-z0-9_-]{1,128})\/hosts\/([A-Za-z0-9_-]{1,128})\/snapshots$/;

function correlationId(request) {
  const received = request.headers["x-correlation-id"];
  return typeof received === "string" && CORRELATION_ID_PATTERN.test(received) ? received : randomUUID();
}

function readWireBody(request, maxWireBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxWireBodyBytes) {
        request.pause();
        reject(new ApiError(413, "WIRE_BODY_TOO_LARGE", "request body exceeds the configured limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", (error) => reject(error));
  });
}

function sendJson(response, status, payload, id, request) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const unreadRequestBody = Boolean(request) && !request.complete;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "x-correlation-id": id,
    ...(unreadRequestBody ? { connection: "close" } : {})
  });
  response.end(body, () => {
    if (unreadRequestBody) {
      request.destroy();
    }
  });
}

export function createApiServer({ service, historyService, config, logger = () => {} }) {
  return createServer((request, response) => {
    const id = correlationId(request);
    handle(request, { service, historyService, config, id })
      .then((result) => {
        logger({ correlationId: id, method: request.method, path: request.url, status: result.status });
        sendJson(response, result.status, result.body, id, request);
      })
      .catch((error) => {
        const status = error instanceof ApiError ? error.status : 500;
        const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
        logger({ correlationId: id, method: request.method, path: request.url, status, code });
        sendJson(response, status, { code, correlationId: id }, id, request);
      });
  });
}

async function handle(request, { service, historyService, config, id }) {
  const url = new URL(request.url, "http://collector-api.local");

  if (request.method === "POST" && url.pathname === "/v1/snapshots") {
    if (url.search) {
      throw new ApiError(400, "QUERY_NOT_ALLOWED", "the snapshot path does not accept a query string");
    }
    const contentEncoding = (request.headers["content-encoding"] ?? "identity").toLowerCase();
    if (!config.allowedContentEncodings.includes(contentEncoding)) {
      throw new ApiError(415, "UNSUPPORTED_CONTENT_ENCODING", "only identity and gzip are supported");
    }
    const wireBody = await readWireBody(request, config.maxWireBodyBytes);
    const result = await service.ingest({
      wireBody,
      contentEncoding,
      headers: request.headers,
      correlationId: id
    });
    return { status: 200, body: result };
  }

  const history = historyService ? HISTORY_PATH_PATTERN.exec(url.pathname) : null;
  if (request.method === "GET" && history) {
    return {
      status: 200,
      body: await historyService.listSnapshots({
        tenantId: history[1],
        hostId: history[2],
        authorization: request.headers.authorization,
        cursor: url.searchParams.get("cursor") ?? undefined,
        pageSize: url.searchParams.get("limit") ?? undefined
      })
    };
  }

  const current = config.devReadApiEnabled ? CURRENT_PATH_PATTERN.exec(url.pathname) : null;
  if (request.method === "GET" && current) {
    return { status: 200, body: await service.readCurrent({ tenantId: current[1], hostId: current[2] }) };
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    return { status: 200, body: { status: "ok" } };
  }

  throw new ApiError(404, "NOT_FOUND", "route not found");
}
