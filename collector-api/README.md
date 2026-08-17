# Collector API

Cloud Run snapshot 수신 API다. 현재는 in-memory 저장소 위에서 동작하는 vertical slice이며 Firestore adapter는 아직 연결하지 않았다.

## 엔드포인트

| Method | Path | 설명 |
| --- | --- | --- |
| `POST` | `/v1/snapshots` | 서명 검증, replay 차단, schema 검증 후 generation을 publish한다 |
| `GET` | `/v1/tenants/{tenantId}/hosts/{hostId}/current` | 현재 published generation 조회. `DEV_READ_API_ENABLED=true`일 때만 열린다 |
| `GET` | `/healthz` | 상태 확인 |

`tenantId`와 `hostId`는 agent registry에서 서버가 결정한다. 요청 body나 header로 저장 경로를 선택할 수 없다.

## POST /v1/snapshots 처리 순서

fail-closed 순서로 처리하며 앞 단계를 통과하지 못하면 뒤 단계를 실행하지 않는다.

1. `Content-Encoding` 확인. `identity`, `gzip` 외에는 `415`
2. HTTP wire body를 상한까지만 읽는다. 초과하면 `413`
3. 서명 header 형식 확인
4. agent registry 조회, `kid` 확인, revoked key 확인
5. wire body 바이트의 SHA-256으로 canonical payload를 만들고 Ed25519 검증
6. timestamp clock skew 확인
7. replay record를 create-only로 기록. 중복 nonce는 `401`
8. gzip 해제. 압축 해제 상한 초과는 `413`
9. JSON 파싱과 snapshot v1 schema 검증
10. process 수 상한과 `capturedAt` 허용 범위 확인
11. `beginSnapshot` → `stageBatch` → `markReady` → `publish`

서명 검증 이후에만 replay record를 생성한다. 검증 전에 nonce를 소모시키지 않는다.

## 상태 코드

| 상태 | 사용 |
| --- | --- |
| `200` | 정상 publish, idempotent 재전송, 오래된 snapshot의 `published:false` 응답 |
| `400` | schema 위반, `capturedAt` 허용 범위 밖, JSON 파싱 실패 |
| `401` | 서명 header 누락 또는 형식 오류, 미등록 agent, 미등록 또는 revoked `kid`, 서명 불일치, clock skew 초과, replay |
| `403` | quarantine agent, agent registry의 tenant/host binding 불일치 |
| `409` | 동일 `snapshotId`의 다른 body hash, generation 상태 충돌 |
| `413` | wire body, 압축 해제 body, process 수 상한 초과 |
| `415` | 지원하지 않는 `Content-Encoding` |

`X-Correlation-Id`는 형식이 맞으면 그대로, 아니면 서버 생성 UUID로 교체해 응답 header와 로그에 전달한다. 로그에는 서명, 헤더 원문, body를 기록하지 않는다.

## 구조

```text
src/config.js                 운영 정책 JSON과 env 병합
src/signing.js                canonical payload, replay ID, Ed25519 검증
src/snapshot-schema.js        snapshot v1 검증
src/snapshot-service.js       수신 처리와 repository 4단계 호출
src/server.js                 HTTP 라우팅, 크기 제한, 오류 매핑
src/in-memory-replay-store.js replay create-only 저장소
src/repository/               generation 상태 전이와 in-memory transaction adapter
scripts/smoke.mjs             서명 push와 current 조회를 한 번에 확인하는 스크립트
```

in-memory adapter는 Firestore 트랜잭션 제약을 그대로 강제한다. 트랜잭션의 모든 읽기는 모든 쓰기보다 앞서야 하고, 트랜잭션과 write batch는 각각 `500` write를 넘을 수 없다. process 재귀 삭제는 트랜잭션 밖에서 `limits.js`의 청크 크기로 나눠 수행한다. 이 제약을 지키면 Firebase SDK adapter는 동일 인터페이스 구현으로 교체할 수 있다.

## 실행

```bash
npm start                      # agent registry가 비어 있으므로 모든 push는 401이다
node collector-api/scripts/smoke.mjs   # 개발용 agent를 등록하고 전체 경로를 확인한다
```

## 미구현

- Firebase SDK repository adapter와 Firestore replay record
- agent 공개키 등록, 회전, 회수 절차와 registry 관리 API
- snapshot history 조회 API와 Firebase Auth ID token 검증
- host `lastAttemptAt`, error category 갱신과 quarantine 운영 절차
- cleanup scheduled job
