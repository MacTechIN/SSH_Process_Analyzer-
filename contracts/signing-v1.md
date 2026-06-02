# Canonical Signing v1

`POST /v1/snapshots` 요청은 다음 UTF-8 바이트를 Ed25519로 서명한다. 각 필드 뒤에는 LF를 붙인다.

```text
POST\n
/v1/snapshots\n
{bodySha256LowerHex}\n
{timestampRfc3339Utc}\n
{nonceLowerHex64}\n
{agentId}\n
{kid}\n
```

- body digest는 HTTP wire body 바이트 기준이다. gzip이면 압축된 바이트를 사용한다.
- 재전송은 최초 wire body 바이트와 `snapshotId`를 유지하고 nonce, timestamp, signature만 새로 만든다.
- `tenantId`, `hostId`, `agentId`, `kid`는 `[A-Za-z0-9_-]{1,128}`만 허용한다.
- replay ID는 `sha256(agentId + LF + kid + LF + nonce)` lowercase hex다.

## Headers

서명은 RFC 4648 base64url without padding으로 인코딩한다.

| 의미 | Header | 상태 |
| --- | --- | --- |
| agent ID | `X-Agent-Id` | 고정 |
| key ID | `X-Agent-Key-Id` | 고정 |
| timestamp | `X-Agent-Timestamp` | 고정 |
| nonce | `X-Agent-Nonce` | 고정 |
| Ed25519 signature | `X-Agent-Signature` | 고정 |

`tenantId`와 `hostId`는 등록된 agent registry에서 서버가 결정한다. 요청 body나 header로 저장 경로를 선택하지 않는다.
