# Collector API

Cloud Run snapshot 수신 API다. 저장소는 `STORAGE_DRIVER`로 고른다.

| 값 | 동작 |
| --- | --- |
| `firestore` | Firebase Admin SDK로 Cloud Firestore에 저장한다. `GOOGLE_CLOUD_PROJECT`가 있으면 기본값이다 |
| `memory` | 프로세스 메모리에 저장한다. 로컬 개발과 테스트 전용이며 재시작하면 사라진다 |

`GOOGLE_CLOUD_PROJECT`가 비어 있으면 `memory`가 기본값이다.

## 엔드포인트

| Method | Path | 설명 |
| --- | --- | --- |
| `POST` | `/v1/snapshots` | 서명 검증, replay 차단, schema 검증 후 generation을 publish한다 |
| `GET` | `/v1/tenants/{tenantId}/hosts/{hostId}/snapshots` | snapshot history 조회. Firebase Auth ID token과 membership이 필요하다. [docs/history-api.md](../docs/history-api.md) |
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
| `503` | replay 저장소 장애, `agentId`가 두 개 이상의 tenant에 등록된 registry 오류, cursor 서명 secret 미설정 |

## Host 상태 메타데이터

인증과 registry binding을 통과한 요청만 host 문서의 `lastAttemptAt`, `lastOutcome`, `lastErrorCategory`, `lastSuccessAt`을 갱신한다. 인증 전 실패는 host 문서를 건드리지 않는다. 이 갱신은 publish 포인터를 절대 바꾸지 않으며, 실패해도 요청 응답을 바꾸지 않는다.

`lastErrorCategory`는 `authentication`, `schema`, `size`, `captured-at`, `conflict`, `registry`, `storage`, `internal` 중 하나다. 구체적인 실패 메시지는 저장하지 않는다.

`X-Correlation-Id`는 형식이 맞으면 그대로, 아니면 서버 생성 UUID로 교체해 응답 header와 로그에 전달한다. 로그에는 서명, 헤더 원문, body를 기록하지 않는다.

## 구조

```text
src/config.js                 운영 정책 JSON과 env 병합
src/signing.js                canonical payload, replay ID, Ed25519 검증
src/snapshot-schema.js        snapshot v1 검증
src/snapshot-service.js       수신 처리와 repository 4단계 호출
src/server.js                 HTTP 라우팅, 크기 제한, 오류 매핑
src/in-memory-replay-store.js replay create-only 저장소
src/firestore-replay-store.js Firestore replay create-only 저장소
src/repository/firestore-store.js  Firestore transaction adapter
src/history-service.js        snapshot history 조회와 membership 확인
src/cursor.js                 history pagination cursor 서명과 검증
src/agent-registry.js         agent 등록, 키 회전, 회수, quarantine
src/cleanup-job.js            만료 generation 재귀 삭제
src/repository/               generation 상태 전이와 in-memory transaction adapter
scripts/smoke.mjs             서명 push와 current 조회를 한 번에 확인하는 스크립트
scripts/agent-admin.mjs       agent registry 운영 CLI
scripts/cleanup.mjs           cleanup job 진입점
scripts/grant-membership.mjs  tenant와 membership 생성
systemd/                      Cloud Run 대신 자체 장비에서 실행할 때 쓰는 unit
```

## Firestore 경로

```text
tenants/{tenantId}/memberships/{uid}
tenants/{tenantId}/agents/{agentId}
tenants/{tenantId}/agents/{agentId}/auditLog/{entryId}
tenants/{tenantId}/hosts/{hostId}
tenants/{tenantId}/hosts/{hostId}/snapshots/{snapshotId}
tenants/{tenantId}/hosts/{hostId}/generations/{snapshotId}
tenants/{tenantId}/hosts/{hostId}/generations/{snapshotId}/processes/{processKey}
replayRecords/{sha256(agentId + LF + kid + LF + nonce)}
```

`agentId`로 tenant를 찾을 때는 `agents` collection group 질의를 쓴다. 서명 payload에 `tenantId`가 없으므로 `agentId`는 전 tenant에서 유일해야 하며, 둘 이상이 걸리면 fail-closed로 `503`을 반환한다.

in-memory adapter는 Firestore 트랜잭션 제약을 그대로 강제한다. 트랜잭션의 모든 읽기는 모든 쓰기보다 앞서야 하고, 트랜잭션과 write batch는 각각 `500` write를 넘을 수 없다. process 재귀 삭제는 트랜잭션 밖에서 `limits.js`의 청크 크기로 나눠 수행한다. 이 제약을 지키면 Firebase SDK adapter는 동일 인터페이스 구현으로 교체할 수 있다.

## 바인딩

`HOST`로 수신 주소를 정한다. 기본값 `0.0.0.0`은 모든 인터페이스를 연다. Tailscale 같은 사설망 위에서만 쓰려면 그 주소를 지정해 LAN과 공인 인터페이스 노출을 막는다.

```text
HOST=100.83.34.122
PORT=8090
```

## 실행

```bash
STORAGE_DRIVER=memory npm start        # 빈 registry로 기동한다. 등록된 agent가 없으므로 push는 401이다
node collector-api/scripts/smoke.mjs   # 개발용 agent를 등록하고 전체 경로를 확인한다
```

## 테스트

```bash
npm test              # in-memory 저장소 기준 unit과 integration
npm run test:emulator # Firestore emulator 기준 repository와 API
```

repository 시나리오는 `tests/helpers/generation-scenarios.js` 하나로 관리하고 in-memory와 Firestore 양쪽에서 동일하게 실행한다.

## 운영

- [agent 키 관리 절차](../docs/agent-key-management.md)
- [cleanup job과 TTL 정책](../docs/cleanup-and-ttl.md)
- [snapshot history 조회 API](../docs/history-api.md)

```bash
node collector-api/scripts/agent-admin.mjs help   # agent 등록, 회전, 회수, quarantine
node collector-api/scripts/cleanup.mjs            # 만료 generation 정리
```

## 미구현

- React 웹앱. Phase 5에서 구현한다
- Cloud Run 배포 매니페스트와 runtime service account IAM 설정
- `installationInstanceId` 전송. snapshot schema v1과 서명 header에 자리가 없어 계약 확장이 필요하다
