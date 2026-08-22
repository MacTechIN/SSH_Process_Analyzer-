# SSH Process Analyzer

Linux 원격 서버에서 실행 중인 프로세스를 주기적으로 수집하고, 현재 누가 어떤 작업을 진행 중인지 확인하는 조회 전용 모니터링 시스템이다.

MVP의 중심은 서버 관리가 아니라 프로세스 OS 소유주별 현재 작업 현황과 통계다. SSH 원격 접속, 원격 셸, 프로세스 종료와 같은 제어 기능은 MVP에 포함하지 않는다.

## 주요 기능

- Linux 프로세스 snapshot 주기 수집
- 프로세스 OS 소유주 이름 기준 사용자별 현재 작업 현황
- 작업 유형 분류, 미분류 작업 표시
- CPU, 메모리, 실행 시간 조회
- 사용자별 현재 작업 수와 기간별 통계
- 장시간 실행, 중복 실행 의심, stale/offline 서버 표시
- tenant membership 기반 조회 권한

## 아키텍처

```text
Linux systemd timer oneshot collector
  -> HTTPS push
  -> Cloud Run collector-api
  -> Cloud Firestore
  -> React web app
  -> Firebase Hosting
```

collector 요청은 Ed25519로 서명한다. API는 replay 차단, agent registry binding, snapshot generation publish transaction을 처리한다. 웹앱은 조회 전용이며 raw command 전체와 환경 변수는 노출하지 않는다.

## 디렉터리

```text
collector/       Linux collector와 systemd unit
collector-api/   Cloud Run API
contracts/       JSON Schema, 서명, 통계 계약
docs/            데이터 모델과 운영 정책 결정표
firebase/        Firestore Rules와 index
remote-actions/  MVP에서 비활성인 원격 액션 경계
tests/           fixture와 통합 테스트
web/             React 웹앱
```

## 사용 흐름

1. Linux 서버에 collector와 systemd timer를 설치한다.
2. collector가 process snapshot을 수집하고 서명하여 API로 전송한다.
3. API가 검증을 통과한 snapshot을 Firestore에 publish한다.
4. 사용자는 웹 대시보드에서 OS process 소유주별 현재 작업과 통계를 확인한다.

네 단계 모두 구현되어 있다. 웹앱은 Firebase Spark 요금제 안에서 무료로 배포할 수 있으며 절차는
[docs/deploy-web.md](docs/deploy-web.md)에 있다.

```bash
npm test                              # in-memory 저장소 기준 unit과 integration
npm run test:emulator                 # Firestore emulator 기준 repository, API, Rules matrix
node collector/scripts/dev-run.mjs    # 임시 API에 실제 /proc 수집 결과를 push하고 조회한다
npm run build:web                     # 웹앱 프로덕션 번들
npm run deploy:web                    # 빌드, 아티팩트 검사, Firebase Hosting 배포
```

## 개발 상태

현재 단계: `Phase 6 - staging 배포 완료, P0/E2E 검증 대기`

- 완료: monorepo 기본 구조
- 완료: snapshot JSON Schema v1
- 완료: canonical signing v1과 replay fixture
- 완료: Firestore Rules와 index 초안
- 완료: OS process 소유주 기준 통계 계약
- 완료: generation repository 상태 전이와 in-memory transaction adapter
- 완료: publish pointer 역행 방지, agent binding, quarantine, cleanup claim 단위 테스트
- 완료: Firestore emulator 실행 설정과 Rules 정적 계약 테스트
- 완료: Phase 0 MVP 운영 정책 기본값 확정
- 완료: Firestore 트랜잭션 제약을 저장소 인터페이스에 반영. 읽기 선행, 트랜잭션 `500` write 상한, 재귀 삭제 분리
- 완료: collector-api vertical slice. Ed25519 서명 검증, replay 차단, snapshot v1 검증, generation publish, 현재 세대 조회
- 완료: collector 구현. `/proc` 수집, 마스킹, 서명 push, bounded retry, spool, 중복 실행 방지, systemd unit
- 완료: Firebase SDK repository adapter와 Firestore replay 저장소. emulator에서 동일 시나리오 검증
- 완료: snapshot history 조회 API. Firebase Auth ID token 검증, membership 확인, 서명 cursor pagination
- 완료: agent 등록, 키 회전, 회수, quarantine 운영 CLI와 감사 로그
- 완료: host `lastAttemptAt`과 error category 갱신. publish 포인터와 분리
- 완료: cleanup scheduled job과 `expiresAt` TTL 정책
- 완료: Firestore Rules allow/deny matrix 테스트
- 외부 입력 필요: staging, production GCP/Firebase project ID
- 완료: Phase 5 React 웹앱. 현재 작업 현황, 통계, 서버 상태, 예외 작업, 설정 화면
- 완료: Firebase Hosting 배포 설정과 아티팩트 비밀 정보 검사
- 완료: staging 배포. Firestore Rules와 index, Firebase Hosting 배포 후 공개 주소 확인
- 진행 전: Cloud Run 배포 매니페스트와 service account IAM
- 추후 반영: Figma 파일 기반 UI 컴포넌트와 스타일

운영 정책 기본값과 배포 전 외부 입력 항목은 [docs/phase0-decisions.md](docs/phase0-decisions.md), 전체 구현 계획은 [implement.md](implement.md)에서 관리한다.

## 개발 진행 기록

진행 기록은 시계열로 누적한다. 기존 기록을 수정하거나 덮어쓰기보다 새 항목을 아래에 추가한다.

## 단계별 버전 관리 규칙

각 개발 단계 또는 독립적으로 검증 가능한 작업 단위가 끝날 때마다 아래 절차를 수행한다.

1. 변경 사항과 테스트 결과를 확인한다.
2. 테스트 파일이나 fixture가 추가되면 `tests/` 아래 트리를 기능별로 확장한다.
3. README의 개발 상태와 개발 진행 기록에 날짜, 버전, 작업 설명, 테스트 결과를 추가한다.
4. 변경 파일을 Git commit으로 기록한다.
5. `main` 브랜치를 원격 저장소에 push한다.

기록에는 최소한 아래 내용을 포함한다.

- 날짜
- 버전
- 작업 설명
- 추가 또는 변경된 주요 파일
- 실행한 테스트와 결과
- 남은 작업 또는 미정 운영값

테스트 트리는 구현 범위에 따라 아래 구조에서 확장한다.

```text
tests/
  fixtures/       signing, snapshot, process, auth 입력 데이터
  integration/    API, repository, Firestore Rules, UI 통합 검증
  unit/           모듈 단위 검증이 생기면 추가
  e2e/            staging 사용자 흐름 검증이 생기면 추가
```

### 2026-06-02 - v0.1.0

- 프로젝트 저장소 초기화
- MVP 목적을 OS process 소유주별 현재 작업 현황과 통계 조회로 확정
- Phase 1 기본 디렉터리 생성
- snapshot, signing, analytics 계약 추가
- Firestore Rules, index, env 예시 추가
- Figma 파일은 추후 제공 후 선별 반영 예정

### 2026-06-02 - v0.1.1

- 단계 완료 시 README 기록, Git commit, `main` push를 수행하는 규칙 추가
- 테스트가 생기면 `tests/` 트리를 fixture, integration, unit, e2e로 확장하도록 기준 추가
- 테스트: 문서 변경만 수행했으며 애플리케이션 테스트는 아직 없음
- 남은 작업: Phase 0 운영 정책 값 확정, collector/API/web 실제 구현

### 2026-06-02 - v0.2.0

- Phase 2 generation repository 상태 전이 구현
- in-memory transaction adapter 추가
- immutable process staging, batch manifest 완료, 0건 snapshot publish 구현
- agent tenant/host binding, quarantine, 오래된 snapshot과 동일 시각 snapshot pointer 역행 방지 구현
- cleanup `deleting` claim, active resume lease 차단, idempotent delete 구현
- Firestore Rules를 현재 published generation만 브라우저에서 읽을 수 있도록 제한
- Firestore emulator 설정과 `tests/unit/`, `tests/integration/` 트리 추가
- 테스트: `npm test` 통과, unit 및 Rules 정적 계약 테스트 13개 성공
- 테스트: JSON 설정 파일 `jq empty` 검증 성공
- 미실행: Firebase SDK 기반 emulator 통합 테스트는 adapter 연결 후 수행
- 남은 작업: Phase 0 운영 정책 값 확정, Firebase adapter와 emulator 통합 테스트, Phase 3 collector API vertical slice

### 2026-06-02 - v0.2.1

- Phase 0 MVP 운영 정책 기본값 확정
- 수집 주기 `60`초, snapshot 보존 `7`일, replay TTL `24`시간으로 확정
- gzip 허용, wire body `8 MiB`, 압축 해제 body `16 MiB`, process 최대 `10,000`개로 확정
- 초과 요청은 HTTP `413` 전체 reject, Firestore batch는 process `400`개 단위로 확정
- 장시간 실행 `24`시간, stale `2`분, warn `5`분, offline `15`분으로 확정
- cleanup job은 `1`시간 주기, 실행당 generation `100`개, timeout `15`분, 최대 재시도 `3`회로 확정
- 구현 공통값을 `contracts/operational-policy-v1.json`에 추가
- 테스트: `jq empty` 검증 성공, `npm test` unit 및 계약 테스트 `16`개 성공
- 외부 입력 필요: staging, production GCP/Firebase project ID
- 남은 작업: Firebase adapter와 emulator 통합 테스트, Phase 3 collector API vertical slice

### 2026-08-17 - v0.3.0

- generation repository의 트랜잭션 경계를 Firestore 제약에 맞게 수정
- `stageBatch`의 process 중복 검사를 읽기 대신 create-only write 실패로 위임. 트랜잭션 내 읽기-쓰기 교차와 batch당 최대 `400`회 읽기 제거
- `markReady`, `publish`의 process 개수 검증을 전량 조회에서 generation의 `stagedProcessCount` 누적 카운터로 교체. 트랜잭션 내 최대 `10,000`건 읽기 제거
- `finishCleanup`을 claim 검증 트랜잭션, 트랜잭션 밖 `400`건 청크 삭제, 메타데이터 삭제 트랜잭션으로 분리. write batch `500` 한계 초과 제거
- `publish`의 관측 불가능한 `publishing` 중간 write 제거. `deleting` claim 차단 로직은 유지
- in-memory adapter에 Firestore 제약 가드 추가. 읽기 선행 위반은 `TRANSACTION_READ_AFTER_WRITE`, 트랜잭션 `500` write 초과는 `TRANSACTION_WRITE_LIMIT`, batch `500` write 초과는 `BATCH_WRITE_LIMIT`로 실패
- 트랜잭션 인터페이스에서 `getProcess`, `listProcesses`, `deleteProcesses` 제거
- 추가 파일: `collector-api/src/repository/limits.js`, `tests/unit/in-memory-store-contract.test.js`
- 테스트: `npm test` 통과, 기존 `16`개 유지에 신규 `6`개 추가하여 `22`개 성공
- 남은 작업: Phase 3 collector-api vertical slice, Firebase adapter, emulator 통합 테스트
- 미실행: emulator 통합 테스트와 Rules allow/deny matrix는 어댑터와 웹 클라이언트 작업 시점으로 이동

### 2026-08-17 - v0.4.0

- collector-api vertical slice 구현. 의존성 없이 Node 내장 모듈만 사용
- `POST /v1/snapshots` 구현. `Content-Encoding` 확인, wire body 상한, 서명 header 검증, agent registry 조회, revoked key 거부, Ed25519 검증, clock skew 확인, replay create-only 기록, gzip 해제 상한, snapshot v1 검증, process 수 상한, `capturedAt` 허용 범위 확인 후 `beginSnapshot` → `stageBatch` → `markReady` → `publish` 호출
- 서명 검증을 통과한 요청만 replay record를 생성하도록 순서 고정
- gzip 요청의 body digest를 압축된 wire 바이트 기준으로 계산하는 계약을 실제 요청으로 검증
- `GET /v1/tenants/{tenantId}/hosts/{hostId}/current` 추가. `DEV_READ_API_ENABLED=true`일 때만 열리는 검증용 조회이며 기본값은 비활성
- `X-Correlation-Id` 수신 또는 생성 후 응답 header와 로그에 전달. 서명과 body는 로그에 기록하지 않음
- 저장소에 비트랜잭션 읽기 `findAgent`, `readHost`, `readGeneration`, `listProcesses` 추가
- 추가 파일: `collector-api/src/`의 `config.js`, `signing.js`, `snapshot-schema.js`, `snapshot-service.js`, `server.js`, `in-memory-replay-store.js`, `api-error.js`, `index.js`, `scripts/smoke.mjs`
- 테스트: `npm test` 통과, unit `24`개와 integration `13`개 합계 `37`개 성공
- 테스트: signing v1 fixture의 body digest, canonical payload, canonical hash, replay document ID 4개 벡터가 구현과 일치함을 확인
- 검증: `node collector-api/scripts/smoke.mjs`로 서명 push와 현재 세대 조회 정상 동작 확인
- 남은 작업: Firebase adapter와 emulator 통합 테스트, collector 구현, snapshot history 조회 API, host `lastAttemptAt` 갱신, cleanup scheduled job

### 2026-08-17 - v0.5.0

- Phase 4 collector 구현. 의존성 없이 Node 내장 모듈만 사용
- `/proc` 수집 구현. `stat` 파싱은 comm에 공백과 괄호가 있어도 마지막 `)` 기준으로 처리
- `startedAt`은 `/proc/stat`의 `btime`과 `startTicks / CLK_TCK`로 계산, `cpuPercent`는 누적 CPU를 실행 시간으로 나눈 값
- `ownerName`은 `/etc/passwd` 조회 후 형식이 맞지 않으면 `uid-{n}`으로 대체
- cmdline 마스킹 구현. 민감 키 할당값, 민감 플래그 다음 인자, URI credential, PEM 유사 문자열, 경로가 아닌 `32`자 이상 불투명 문자열을 `[redacted]` 처리
- 인자는 최대 `16`개, 항목당 `256`자로 제한. raw command 전체와 환경 변수는 전송하지 않음
- 재시도와 spool 재전송에서 최초 wire body 바이트와 `snapshotId`를 유지하고 nonce, timestamp, signature만 재생성
- bounded retry 구현. `429`와 `5xx`, 네트워크 오류만 재시도하고 exponential backoff에 full jitter 적용
- spool 구현. 권한 `0700` 디렉터리와 `0600` 파일, 만료 삭제, 파일 수와 byte 상한 초과 시 oldest-drop
- 영구 거부 응답을 받은 spool 항목은 재시도하지 않고 폐기
- lock 파일로 중복 실행 방지. stale lock은 pid 생존 확인 후 회수
- systemd oneshot service와 `60`초 timer 추가. `NoNewPrivileges`, `ProtectSystem=strict`, 빈 `CapabilityBoundingSet` 적용
- collector와 collector-api의 canonical signing 동일성을 교차 테스트로 고정
- 추가 파일: `collector/src/`의 `config.js`, `signing.js`, `masking.js`, `proc.js`, `snapshot.js`, `spool.js`, `sender.js`, `lock.js`, `run-once.js`, `index.js`, `collector/systemd/`, `collector/scripts/dev-run.mjs`
- 테스트: `npm test` 통과, unit `50`개와 integration `17`개 합계 `67`개 성공
- 검증: `node collector/scripts/dev-run.mjs`로 실제 `/proc` process `1,045`개를 수집해 서명 push, publish, 조회까지 확인
- 미전송: `installationInstanceId`는 생성하고 보관하지만 schema v1과 서명 header에 자리가 없어 전송하지 않음. 서버 측 clone 판정은 계약 확장 후 가능
- 남은 작업: Firebase adapter와 emulator 통합 테스트, snapshot history 조회 API, agent 키 등록과 회전 절차, cleanup job, web 구현

### 2026-08-18 - v0.6.0

- Firebase Admin SDK 기반 Firestore repository adapter와 replay 저장소 추가
- `STORAGE_DRIVER`로 `firestore`와 `memory`를 선택. `GOOGLE_CLOUD_PROJECT`가 있으면 `firestore`가 기본값
- Firestore 읽기가 비동기이므로 저장소 트랜잭션 인터페이스를 async로 통일하고 repository의 모든 읽기·쓰기를 await 처리
- repository 시나리오를 `tests/helpers/generation-scenarios.js`로 분리해 in-memory와 Firestore 양쪽에서 동일하게 실행
- emulator 기준 repository 시나리오 `15`개와 API 시나리오 `3`개 통과
- `agentId`가 두 개 이상의 tenant에 등록되면 조회가 임의의 문서를 고르던 문제를 fail-closed로 수정. `AGENT_ID_NOT_UNIQUE`와 HTTP `503`으로 응답하며 collector는 spool에 보관 후 재시도
- 서명 payload에 `tenantId`가 없으므로 `agentId`는 전 tenant에서 유일해야 한다는 제약을 계약 문서에 명시
- Firestore emulator 포트를 `8085`, UI 포트를 `4400`으로 변경. 기본값 `8080`과 `4000`은 로컬 서비스와 충돌한다
- `firebase-tools`를 `13.x`로 고정. `14` 이상은 JDK `21` 이상을 요구하고 현재 환경은 JDK `17`이다
- spool 재전송 통합 테스트가 같은 초에 두 snapshot을 만들면 실패하던 문제 수정. 명시적 시계를 주입하고 동일 `capturedAt` 회귀 테스트를 추가
- 테스트: `npm test` unit `52`개와 integration `19`개 합계 `71`개 성공
- 테스트: `npm run test:emulator` Firestore emulator 기준 `18`개 성공
- 남은 작업: snapshot history 조회 API, agent 키 등록과 회전 절차, cleanup job, `expiresAt` TTL, Rules matrix, web 구현

### 2026-08-18 - v0.7.0

- snapshot history 조회 API 구현. `GET /v1/tenants/{tenantId}/hosts/{hostId}/snapshots`
- Firebase Auth ID token을 검증하고 서버가 `tenants/{tenantId}/memberships/{uid}`를 읽어 권한을 판단. custom claims는 사용하지 않음
- 미인증은 HTTP `401`, membership 없음은 HTTP `403`과 데이터 0건
- pagination cursor를 HMAC-SHA256으로 서명. `uid`, `tenantId`, `hostId`, 정렬 기준, `pageSize`, `retentionCutoff`, 만료 시각, 마지막 문서 키를 매 요청에서 재검증
- cursor가 페이지네이션 세션의 `retentionCutoff`를 고정하도록 구현. 요청마다 재계산하면 페이지 사이에서 조회 창이 움직여 행이 누락된다
- `CURSOR_SIGNING_SECRET` 미설정 시 history API를 HTTP `503`으로 fail-closed 처리
- snapshot history 문서를 publish transaction에서 기록. 포인터를 갱신하지 못한 오래된 snapshot도 `published:false`로 보존
- `expiresAt`을 서버가 계산해 generation과 history 양쪽에 기록. TTL 삭제 지연 시에도 만료 문서를 응답에서 제외
- agent registry 운영 모듈과 CLI 추가. 등록, 키 회전, 회수, quarantine, 해제와 감사 로그
- 마지막 활성 키 회수 차단, `agentId` 전 tenant 유일성 강제, quarantine 해제 시 운영자와 사유 필수
- host `lastAttemptAt`, `lastOutcome`, `lastErrorCategory`, `lastSuccessAt` 갱신 구현. 인증 전 실패는 host 문서를 변경하지 않고 publish 포인터도 바꾸지 않음
- cleanup scheduled job 구현. 만료 generation을 claim 후 트랜잭션 밖 `400`건 청크로 재귀 삭제하며 current pointer, `ready`, `publishing`, 유효 resume lease는 건너뜀
- Firestore Rules allow/deny matrix 테스트 추가. 미인증 거부, 비멤버 거부, tenant 교차 거부, 미publish generation 거부, history·agents·replayRecords 전면 거부, 웹 쓰기 전면 거부
- `generations.expiresAt`과 `agents.agentId` collection group index 추가
- 추가 파일: `collector-api/src/`의 `history-service.js`, `cursor.js`, `agent-registry.js`, `cleanup-job.js`, `scripts/agent-admin.mjs`, `scripts/cleanup.mjs`
- 추가 문서: `docs/agent-key-management.md`, `docs/cleanup-and-ttl.md`, `docs/history-api.md`
- 테스트: `npm test` unit `70`개와 integration `30`개 합계 `100`개 성공
- 테스트: `npm run test:emulator` Firestore emulator 기준 `30`개 성공. repository `15`, API `3`, Rules matrix `8`, history·cleanup·registry `4`
- 남은 작업: Phase 5 React 웹앱, Cloud Run 배포 매니페스트와 service account IAM

### 2026-08-21 - v0.8.0

- Phase 5 React 웹앱 구현. Vite 번들, 의존성은 react, react-dom, firebase 세 개
- Firebase Auth Google Sign-In 연동. 미인증, 권한 거부, empty, loading, 오류 상태를 각각 화면으로 처리
- 첫 화면을 사람별 `현재 작업 현황`으로 구현. KPI 카드 `5`개, 사용자·작업 유형·서버·상태·실행 시간·검색 필터, 상세 drawer
- 기본 정렬을 장시간 실행과 예외 상태 우선, 이후 CPU 내림차순으로 구현
- 통계 화면 구현. 사용자별 작업 수, 작업 유형 점유율, 시간대별 시작 추이, 서버별 CPU·메모리 부하, 장시간 실행 Top `10`
- 예외 작업 화면 구현. 장시간 실행, 중복 실행 의심, 미분류, 최근 수집 없는 서버의 작업
- 서버 상태 화면에서 `마지막 정상 publish`, `API 수신 후 실패`, `stale/offline`을 분리해 표시
- Snapshot History는 서버 조회 API를 사용하며 미설정 시 해당 화면만 안내를 표시하고 나머지는 정상 동작
- 실시간 구독 대신 요청 시점 조회로 구현. 실시간 구독은 collector push마다 전체 process를 다시 읽어 Firestore 무료 할당량을 소진한다
- 화면 로직을 `web/src/lib/`의 순수 함수로 분리하고 unit 테스트 `16`개 추가
- Firebase Hosting 설정 추가. SPA rewrite, asset 캐시 헤더, `nosniff`, `DENY` frame, `no-referrer`
- Hosting 아티팩트 검사 스크립트 추가. source map, `.env`, private key, service account JSON, 서버 secret 이름을 검사하고 배포를 중단
- membership 부여 CLI 추가. 로그인만으로는 데이터가 보이지 않으며 membership 문서가 있어야 조회된다
- 무료 배포 문서 추가. Firebase Spark 요금제 안에서 Hosting, Auth, Firestore를 쓰고 collector-api는 자체 장비에서 실행
- 테스트: `npm test` unit `86`개와 integration `30`개 합계 `116`개 성공
- 검증: `npm run build:web` 성공, `npm run verify:web` 아티팩트 검사 통과
- 미검증: 브라우저 렌더링 확인은 Chrome이 로컬 preview 서버에 접근하지 못해 수행하지 못함. 번들에 화면 문자열이 포함된 것만 확인
- 남은 작업: 실제 Firebase 프로젝트 생성과 배포, Cloud Run 배포 매니페스트, staging P0/E2E

### 2026-08-22 - v0.8.1

- staging Firebase 프로젝트에 첫 배포 수행. Firestore Rules와 index, Hosting 배포 완료
- `firebase.json`을 저장소 루트로 이동. Hosting `public` 경로는 config 파일보다 상위에 둘 수 없다
- 단일 필드 index를 `indexes` 배열에서 `fieldOverrides`로 이동. Firestore는 단일 필드 index를 자동 생성하므로 composite 배열에 넣으면 `400`으로 거부한다
- collection group 질의에 필요한 `generations.expiresAt`과 `agents.agentId`는 `fieldOverrides`에서 `COLLECTION_GROUP` scope로 선언
- Hosting 헤더 순서 수정. `/index.html` 규칙은 `/` 요청에 적용되지 않아 HTML이 `max-age=3600`으로 캐시되던 문제를 `**` 우선 규칙으로 해결
- 배포 검증: HTML `no-cache`, asset `immutable`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, SPA rewrite 동작 확인
- 테스트: `npm test` `116`개, `npm run test:emulator` `30`개 성공
- 남은 작업: membership 부여, collector-api 연결, staging P0/E2E

### 2026-08-22 - v0.8.2

- membership 조회 Rules의 순환 구조 수정. `isTenantMember()`가 읽으려는 문서의 존재를 확인하고 있어, membership이 없는 사용자는 빈 결과 대신 `permission-denied`를 받았다
- 로그인한 사용자는 자신의 membership 문서를 존재 여부와 무관하게 읽을 수 있도록 변경. 노출되는 정보는 본인 role뿐이다
- 웹앱이 `permission-denied`를 권한 없음 상태로 처리하도록 수정. 이전에는 일반 오류 화면이 떴다
- emulator Rules matrix에 비멤버의 자기 membership 조회 허용과 미인증 거부 검증 추가
- 테스트: `npm test` `116`개, `npm run test:emulator` `31`개 성공
- 배포: Rules와 Hosting 재배포 완료

### 2026-08-22 - v0.9.0

- collector-api 바인딩 주소를 `HOST`로 설정 가능하게 변경. 기본값은 `0.0.0.0`이며 사설망 주소를 지정하면 LAN과 공인 인터페이스 노출을 막는다
- 웹앱 health 임계값을 실제 수집 주기에 맞춰 확대하도록 변경. `VITE_COLLECT_INTERVAL_SECONDS`가 없으면 `60`초 기준을 그대로 쓴다
- `60`초 기준 임계값을 `1`시간 주기 배포에 그대로 쓰면 모든 서버가 항상 오프라인으로 표시되는 문제를 해결
- sudo 없이 사용자 systemd 유닛으로 collector를 설치하는 스크립트 추가. 키 생성과 유닛 설치 후 등록에 필요한 `hostId`, `agentId`, 공개키를 출력한다
- 자체 장비 실행용 collector-api systemd unit 템플릿 추가
- 운영 배포: collector-api를 사용자 systemd 서비스로 상시 실행하고 Tailscale 주소에만 바인딩. collector는 `1`시간 주기 타이머로 등록
- 수집 주기와 Firestore 무료 쓰기 한도의 관계를 문서화. process `800`개 서버는 하루 약 `24`회가 상한이다
- 테스트: `npm test` `117`개 성공
- 남은 작업: 두 번째 수집 대상 서버 등록, staging P0/E2E

## 참고 문서

- [데이터 모델 v1](docs/data-model-v1.md)
- [Phase 0 운영 정책 결정표](docs/phase0-decisions.md)
- [Snapshot Schema v1](contracts/snapshot-v1.schema.json)
- [Canonical Signing v1](contracts/signing-v1.md)
- [Analytics v1](contracts/analytics-v1.md)
- [Operational Policy v1](contracts/operational-policy-v1.json)
- [Agent 키 관리 절차](docs/agent-key-management.md)
- [Cleanup job과 TTL 정책](docs/cleanup-and-ttl.md)
- [Snapshot history 조회 API](docs/history-api.md)
- [웹앱 무료 배포](docs/deploy-web.md)
