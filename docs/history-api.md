# Snapshot history 조회 API

웹 클라이언트는 snapshot history를 Firestore에서 직접 읽지 않는다. Rules가 `snapshots` 컬렉션을 모든 클라이언트에게 닫아 두었고, 조회는 이 API만 사용한다.

```text
GET /v1/tenants/{tenantId}/hosts/{hostId}/snapshots?limit=50&cursor=<opaque>
Authorization: Bearer <Firebase Auth ID token>
```

## 인증과 권한

1. `Authorization: Bearer` 헤더의 Firebase Auth ID token을 서버가 검증한다
2. 검증된 `uid`로 `tenants/{tenantId}/memberships/{uid}` 문서를 읽는다
3. membership이 없거나 삭제되었으면 HTTP `403`과 데이터 0건이다
4. 미인증 또는 검증 실패는 HTTP `401`이다

custom claims는 권한 판단에 쓰지 않는다. 서버가 membership 문서를 직접 읽는다.

`tenantId`와 `hostId`는 경로에서 받지만 조회 경로는 서버가 결정하고 membership 범위 밖이면 데이터를 반환하지 않는다.

## 범위 제한

- 정렬은 `capturedAt` 내림차순 고정이다
- `capturedAt >= retentionCutoff`로 범위를 좁힌다. `retentionCutoff`는 수신 시각에서 보존 기간을 뺀 값이다
- `limit`은 기본값과 상한이 `HISTORY_PAGE_SIZE_LIMIT`이다. 초과하면 HTTP `400`이다
- TTL 삭제가 지연되어 남아 있는 문서는 `expiresAt`을 서버에서 확인해 응답에서 제외한다

## Cursor

`nextCursor`는 서버가 HMAC-SHA256으로 서명한 opaque 문자열이다. payload에는 `uid`, `tenantId`, `hostId`, 정렬 기준, `retentionCutoff`, `pageSize`, `issuedAt`, `expiresAt`, 마지막 문서 키가 들어간다.

매 요청에서 서버가 다시 검증하는 항목은 다음과 같다.

- 서명. 위조나 다른 서명 키로 만든 cursor는 거부한다
- `expiresAt`. 기본 `15`분이 지나면 거부한다
- `uid`, `tenantId`, `hostId`, 정렬 기준, `pageSize`. 하나라도 현재 요청과 다르면 거부한다
- `retentionCutoff`. cursor가 페이지네이션 세션의 필터를 고정하며, 보존 기간과 cursor 수명을 합친 범위보다 오래되면 거부한다

`retentionCutoff`를 cursor에 고정하는 이유는 요청마다 다시 계산하면 페이지 사이에서 조회 창이 움직여 행이 누락되거나 중복되기 때문이다.

## Cursor 서명 키 회전

`CURSOR_SIGNING_SECRET`은 Secret Manager에 두고 `CURSOR_SIGNING_KEY_ID`로 버전을 표시한다.

1. 새 secret 값을 준비한다
2. 배포에서 `CURSOR_SIGNING_SECRET`과 `CURSOR_SIGNING_KEY_ID`를 함께 교체한다
3. 회전 시점에 열려 있던 cursor는 서명 검증에서 거부되고 클라이언트는 첫 페이지부터 다시 조회한다. cursor 수명이 `15`분이므로 영향 구간은 짧다

secret이 설정되지 않으면 history API는 HTTP `503` `CURSOR_SIGNING_NOT_CONFIGURED`로 fail-closed 처리한다.

## 응답

```json
{
  "tenantId": "acme",
  "hostId": "web-01",
  "role": "viewer",
  "snapshots": [
    { "snapshotId": "…", "capturedAt": "…", "processCount": 512, "published": true, "storedAt": "…" }
  ],
  "nextCursor": "…"
}
```

process 목록과 마스킹 대상 필드는 이 API가 반환하지 않는다. 현재 세대의 process는 Rules가 허용하는 published generation 경로에서 웹 클라이언트가 직접 읽는다.
