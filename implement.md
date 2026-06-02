# SSH Process Monitoring Analyzer 구현 계획

## 1. 목적

Linux 서버의 프로세스 상태를 주기적으로 수집하고, 현재 누가 어떤 작업을 프로세스로 진행 중인지 식별하여 웹에서 조회하고 통계화하는 모니터링 시스템을 구축한다.

MVP의 중심 사용자 가치는 서버 자체의 상태 관리가 아니라 사람별 현재 작업 현황 파악이다. 서버 상태는 작업 현황을 해석하기 위한 보조 정보로 제공한다.

MVP는 조회 전용이다. SSH pull, 원격 셸, 프로세스 종료 등 원격 액션은 구현하지 않는다.

## 2. MVP 아키텍처

```text
Linux systemd timer oneshot collector
  -> HTTPS push
  -> Cloud Run collector-api
  -> Cloud Firestore
  -> React web app
  -> Firebase Hosting
```

Firebase·GCP 프로젝트 base name 후보는 `ssh-analyzer`이다. 실제 `stagingProjectId`, `prodProjectId`는 배포 전에 외부 입력으로 지정하고 Firebase CLI alias는 `staging`, `production`으로 고정한다.

- 웹앱 배포: Firebase Hosting
- 데이터 저장: Cloud Firestore
- 웹 클라이언트 초기화: 제공된 Firebase Web SDK 공개 설정 사용
- 원본 snapshot 파일의 Cloud Storage 보관: 기본 OFF
- 서버 자격 증명과 agent private key: 웹 번들 및 Firestore에 포함 금지

## 3. 작업 루트와 디렉터리

모든 코드, 문서, fixture, 배포 설정은 `/home/jnh/workspace/ssh_process_mgmt` 아래에서만 생성하거나 수정한다.

예상 디렉터리:

```text
collector/             Linux 수집기와 systemd unit
collector-api/         Cloud Run API
web/                   React 웹앱
firebase/              Firestore Rules, indexes, Hosting 설정
docs/                  운영 및 보안 문서
tests/fixtures/         인증, snapshot, process fixture
tests/integration/      API, Firestore Rules, UI 통합 테스트
```

## 4. 구현 단계

### Phase 0. 운영 정책 확정

MVP 운영 기본값은 `docs/phase0-decisions.md`에서 확정한다. 실제 staging/prod GCP·Firebase project ID는 배포 전에 외부 입력으로 지정한다.

- 서버 수, 서버당 평균 및 최대 프로세스 수
- 저장할 프로세스 필드와 `args` 마스킹 범위
- 화면의 사용자 이름은 프로세스 OS 소유주 이름을 그대로 사용. MVP에서는 별도 사용자 매핑과 작업 메타데이터 기반 담당자 추론을 구현하지 않음
- 프로세스에서 작업 유형을 분류하는 규칙과 미분류 fallback. raw cmdline 전체를 저장하거나 브라우저에 노출하지 않고 실행 파일, 허용된 인자, 작업 경로 등 allowlist 필드만 사용
- 장시간 실행과 중복 실행 의심 상태의 판정 기준
- replay 허용 clock skew와 nonce 보존 시간
- `capturedAt` 미래 허용 skew와 spool 과거 허용 기간, 미래 시각 poisoning 운영자 복구 절차
- VM clone 의심 시 quarantine 조건과 해제 절차
- 프로세스 안정 키: `sha256(bootId + LF + pid + LF + startTicks)` lowercase hex
- offline backlog 허용 여부, 로컬 spool 상한과 만료 시간
- snapshot 보존 기간
- stale, warn, offline 판정 시간
- GCP 리전, `stagingProjectId`, `prodProjectId`, staging/prod Firebase CLI alias
- 로그인 방식과 viewer/operator/admin별 tenant 접근 범위
- 지원 Linux 배포판, 프록시, 사설 CA 사용 여부
- API 최대 body 크기, gzip 요청 허용 여부, 서버당 최대 프로세스 수
- gzip 허용 시 압축 body와 압축 해제 body 각각의 최대 크기
- 최대 프로세스 수 또는 요청 크기 초과 시 정책: HTTP `413` 전체 reject. MVP에서 truncate 금지
- Firestore write batch 분할 크기와 모든 batch 성공 후에만 generation을 `ready`로 전환하는 완료 조건
- 10k 초과 또는 Firestore 한계 초과 시 저장 정책: 분할 publish, 요약 저장, 수집 거부 중 선택

### Phase 1. 스캐폴딩과 계약 정의

- monorepo 디렉터리 생성
- 데이터 schema v1 문서화
- collector와 API 사이의 요청 JSON schema 정의
- schema에 프로세스 OS 소유주 이름, 작업 분류용 allowlist 필드, 서버 계산 또는 분류 결과, 미분류 상태를 포함
- 사람별 현재 작업 수와 기간별 통계를 어떤 집계 단위로 계산하고 보존할지 정의
- 아래 canonical signing payload와 replay 저장 계약을 테스트 벡터로 고정
- Firestore collection 구조와 index 초안 작성
- tenant-root collection 구조, membership 기준 권한표, Firestore Rules 초안 작성
- 환경 변수 목록 작성. Firebase Web SDK 공개 설정은 프론트 전용 env 예시로만 두고 서버 설정 및 secret과 분리한다.
- 미래 확장 인터페이스를 목적 주석만 가진 비활성 계약으로 추가
- 원격 액션 인터페이스는 별도 모듈로 격리하고 MVP 코드에서 import 금지

canonical signing payload는 아래 규격의 UTF-8 바이트로 고정한다.

- 필드 구분자는 LF(`\n`)이며 각 필드는 한 줄이다. 마지막 필드 뒤에도 LF를 붙인다.
- HTTP method는 대문자 `POST`만 허용한다.
- path는 `/v1/snapshots` 리터럴만 허용한다. query string, percent-decoding 재해석, 중복 slash 정규화는 허용하지 않는다.
- timestamp는 UTC RFC 3339 형식 `YYYY-MM-DDTHH:mm:ssZ`만 허용한다.
- body digest는 HTTP wire body 바이트의 SHA-256 lowercase hex 문자열이다. `Content-Encoding: gzip`이면 압축된 wire 바이트를 사용한다. 압축 해제 또는 JSON 재직렬화 후 digest를 계산하지 않는다.
- nonce는 32바이트 암호학적 난수의 lowercase hex 64자 문자열이다.
- `tenantId`, `hostId`, `agentId`, `kid`는 path-safe 등록 식별자로 제한한다. schema v1에서 `[A-Za-z0-9_-]{1,128}` 형식을 검증하며 slash, LF, percent-encoded 우회 입력을 허용하지 않는다.
- replay uniqueness scope는 `agentId + kid + nonce`이다. replay document ID는 `sha256(agentId + LF + kid + LF + nonce)` lowercase hex로 고정하고 원본 scope 필드는 문서 데이터에 저장한다. replay record는 Firestore create-only transaction으로 원자 생성하며 Phase 0에서 정한 replay TTL 동안 보존한다.
- 동일 `snapshotId` 재시도는 동일 body를 사용하더라도 새 nonce와 새 timestamp로 다시 서명한다. snapshot 저장 멱등성과 replay 차단은 별도 계약이다.

```text
POST\n
/v1/snapshots\n
{bodySha256LowerHex}\n
{timestampRfc3339Utc}\n
{nonceLowerHex64}\n
{agentId}\n
{kid}\n
```

tenant-root 경로와 권한 기준은 아래로 고정한다.

```text
tenants/{tenantId}
tenants/{tenantId}/memberships/{uid}
tenants/{tenantId}/hosts/{hostId}
tenants/{tenantId}/hosts/{hostId}/snapshots/{snapshotId}
tenants/{tenantId}/hosts/{hostId}/generations/{snapshotId}
tenants/{tenantId}/hosts/{hostId}/generations/{snapshotId}/processes/{processKey}
tenants/{tenantId}/agents/{agentId}
replayRecords/{sha256(agentId + LF + kid + LF + nonce)}
```

Firebase Auth의 `uid`와 `tenants/{tenantId}/memberships/{uid}` 문서를 권한 기준으로 사용한다. custom claims는 UI 힌트 또는 최적화 용도로만 사용하고 Rules 권한 원본으로 사용하지 않는다.

| 역할 | tenant 조회 | host/process 조회 | history 서버 API 조회 | 웹 직접 쓰기 |
| --- | --- | --- | --- | --- |
| viewer | 허용된 tenant만 | 읽기 허용 | 허용 | 금지 |
| operator | 허용된 tenant만 | 읽기 허용 | 허용 | 금지 |
| admin | 허용된 tenant만 | 읽기 허용 | 허용 | 금지 |

MVP에서 role별 차이는 UI 표시에만 최소한으로 두며, 웹 클라이언트 쓰기 권한은 모두 열지 않는다.

비활성 확장 계약:

```text
compare_snapshots
evaluate_custom_rules
send_alert
build_process_tree
map_container_context
export_report

remote-actions/request_remote_action
remote-actions/execute_remote_action
```

### Phase 2. Firestore Rules와 generation repository 구현

- Firestore Rules emulator와 storage repository 테스트 환경 구성
- tenant별 데이터 격리
- snapshot history와 generation 데이터 경로 분리
- process는 `tenants/{tenantId}/hosts/{hostId}/generations/{snapshotId}/processes/{processKey}`에 immutable staging write
- generation 메타데이터는 `staging -> ready -> publishing -> published`, `failed-retryable`, `deleting` 상태로 관리
- 동일 `snapshotId`와 hash 재전송 시 상태별 동작을 고정한다: `staging` 또는 `failed-retryable`은 batch manifest를 기준으로 누락 batch를 resume하고, `ready`는 pointer publish를 재시도하며, `published`만 no-op 성공 처리한다. 동일 ID와 다른 hash는 conflict로 거부한다.
- 모든 process batch와 generation 메타데이터 기록 완료 후에만 host 문서의 `publishedGeneration={snapshotId}`와 `publishedSnapshotId={snapshotId}` 포인터를 transaction으로 원자 갱신
- publish transaction은 agent registry의 tenant/host binding과 quarantine 상태, host의 `publishedCapturedAt`을 함께 읽는다. `generation.capturedAt > host.publishedCapturedAt`인 정상 agent 요청만 pointer를 갱신한다.
- publish transaction은 대상 generation이 해당 tenant/host 아래 존재하며 `ready`, 동일 `snapshotId`, 동일 body hash, expected process count 일치, batch manifest 완료 상태인지 함께 검증한다. 하나라도 불일치하면 fail-closed 처리한다.
- 동일 `capturedAt`과 동일 `snapshotId` 재시도는 idempotent 성공 처리한다. 동일 `capturedAt`의 다른 snapshot과 더 오래된 snapshot은 history에는 보관할 수 있지만 pointer를 갱신하지 않는다.
- UI는 host 포인터가 가리키는 generation 경로만 조회하고 미완료 generation은 조회하지 않음
- 이전 published generation과 실패 또는 미완료 generation은 보존 기한 후 cleanup job으로 하위 process와 함께 삭제
- cleanup은 별도 scheduled Cloud Run job과 최소 권한 cleanup service account가 실행한다. 하위 process를 명시적으로 재귀 삭제하며 idempotent 재실행할 수 있어야 한다.
- cleanup은 host의 현재 `publishedGeneration`을 항상 제외하고 삭제 직전에 포인터를 다시 확인한다. `ready` generation과 publish 진행 중 generation도 삭제하지 않는다. snapshot history 만료와 장기 offline host의 current generation 보존을 분리한다.
- cleanup은 transaction으로 삭제 대상을 `deleting` 상태 claim한다. claim 시점에 현재 `publishedGeneration`이 아니고, 유효한 staging resume lease가 없으며, `ready` 또는 `publishing` 상태가 아님을 검증한다. resume과 publish는 `deleting` generation을 fail-closed 처리한다. recursive delete 완료 후 메타데이터를 제거하며, 중간 실패 시 동일 claim으로 idempotent 재개한다.
- snapshot TTL 적용. current, agent, server 메타데이터는 TTL 대상 제외
- TTL 문서 삭제 시 하위 컬렉션이 자동 삭제되지 않는 점을 고려해 generation과 snapshot 하위 데이터 정리 절차 구현
- `expiresAt`은 TTL field index exemption을 적용한다. snapshot history는 웹 클라이언트의 Firestore 직접 읽기를 금지하고 서버 조회 API만 제공한다. 서버는 indexed `capturedAt >= retentionCutoff`와 개수 상한으로 bounded 조회한 뒤 `expiresAt > now`를 필터링해 만료 문서를 브라우저에 전달하지 않는다. 앱 필터는 보조 방어로만 유지한다.
- history 조회용 `capturedAt` index와 tenant-root 경로에 필요한 index를 정의
- 대량 current 갱신 중 혼합 세대 노출 방지
- PID 재사용을 고려한 안정 키 적용
- 0건 snapshot에서 기존 current 프로세스가 정확히 비워지는지 검증

### Phase 3. collector-api vertical slice 구현

- Cloud Run용 API 구현
- agent ID, `kid`, Ed25519 서명, timestamp, nonce 검증
- 등록된 agent registry에서 `tenantId`, `hostId`, 허용 `kid`를 조회하고 저장 경로를 서버 측에서 결정. 요청 body나 header가 tenant/host 경로를 선택하지 못하게 함
- `capturedAt`은 API 수신 시각 기준으로 Phase 0에서 정한 미래 허용 skew와 spool 과거 허용 기간 안에 있는지 검증한다. `expiresAt`은 서버가 snapshot 보존 정책으로 계산한다. 범위 밖 요청은 history 저장 전에 reject하고 반복 또는 큰 편차는 quarantine 후보로 기록한다.
- replay record atomic create와 replay 차단. 저장소 장애 시 fail-closed
- `Content-Encoding`은 `identity`와 `gzip`만 허용한다. gzip은 streaming decompression 중 압축 해제 body 상한을 넘는 즉시 중단하고 HTTP `413`으로 거부한다. 지원하지 않는 encoding은 HTTP `415`로 거부한다.
- revoked key 거부
- UUIDv4 snapshot create-only 검증
- 동일 ID와 동일 hash 재전송은 성공 처리하되 중복 write 금지
- 동일 ID와 다른 hash는 conflict 처리 및 감사 로그 기록
- 인증, 파싱, 저장 실패 시 마지막 정상 current 상태 보존
- 압축 body 크기, 압축 해제 body 크기, process count 초과는 HTTP `413`으로 전체 reject한다. MVP에서 truncate fallback은 허용하지 않는다.
- agent 공개키 등록, 회전, 회수 절차 문서화
- collector-api 전용 Cloud Run runtime service account와 최소 IAM 적용
- Secret Manager는 서버 측 secret에만 사용하고 Firebase Web SDK 공개 설정 및 agent private key 저장에 사용하지 않음
- `X-Correlation-Id` 수신 또는 생성 후 agent 응답, API 로그, repository 로그에 전달
- secret, Authorization, 원문 서명, 전체 args/env, payload 원문 로그 금지 및 redaction 테스트 추가
- 인증과 registry binding이 검증된 요청만 해당 host의 `lastAttemptAt`과 제한된 error category를 갱신할 수 있다. 인증 전 실패는 host 메타데이터를 변경하지 않고 보안 로그와 metric에만 기록한다. 모든 실패에서 마지막 정상 publish 포인터는 보존한다.
- snapshot history 서버 조회 API는 Firebase Auth ID token을 검증하고 서버 측 membership 문서를 조회한다. 요청 tenant/host가 membership 범위인지 확인한 뒤 서버가 Firestore 경로를 결정한다. pagination cursor는 서버가 서명한 opaque cursor로 제한하고 page limit 상한을 적용한다. cursor payload는 `uid` 또는 membership scope, `tenantId`, `hostId`, sort field/order, retention cutoff 또는 filter hash, page size 상한, `issuedAt`, `expiresAt`, last document key를 포함하며 서버가 매 요청에서 모두 재검증한다. cursor signing key 회전 정책도 문서화한다. 미인증은 HTTP `401`, 권한 없음 또는 삭제된 membership은 HTTP `403`과 데이터 0건으로 처리한다.

### Phase 4. collector 구현

- Linux 프로세스 수집
- 민감정보 마스킹
- 프로세스 OS 소유주 이름과 작업 분류에 필요한 allowlist 필드만 수집하고, 작업 분류가 불가능한 경우 미분류 상태로 전달
- UUIDv4 `snapshotId` 생성
- Ed25519 서명
- HTTPS push
- bounded retry, backoff, jitter
- 재시도 시 동일 `snapshotId`와 동일 body hash 유지
- 중복 실행 방지
- systemd oneshot unit과 timer 제공
- backlog 허용 시 권한 제한 spool 디렉터리, byte/file 상한, 만료 시간, oldest-drop 또는 reject 정책 적용
- spool 재전송 시 동일 `snapshotId`와 동일 body hash 유지
- gzip 사용 여부와 관계없이 최초 생성한 exact HTTP wire body bytes를 권한 제한 spool에 보존하고 모든 재전송에 그대로 사용한다. 재전송은 nonce, timestamp, signature만 새로 생성한다.
- 설치 시 `installationInstanceId`를 별도 생성하고 agent ID, key fingerprint, 최소 비민감 host fingerprint와 함께 전송
- clone 의심 판정은 installation instance ID 충돌 또는 agent/key/fingerprint 조합 충돌을 기준으로 하고 IP만으로 판정하지 않음
- clone 의심 시 latest publish 차단, quarantine 기록, 자동 해제 금지, 수동 해제 감사 로그 기록
- quarantine 상태 확인과 latest pointer publish 차단은 repository publish transaction 안에서 원자 처리
- 로그에 private key, Authorization, 원문 서명, 전체 payload, 민감 cmdline 기록 금지

### Phase 5. React 웹앱 구현

- Firebase Auth 연동
- Firestore 조회 전용 연결. snapshot history는 만료 데이터 전달 방지를 위해 서버 조회 API를 사용
- 첫 화면은 사람별 `현재 작업 현황`으로 구현. 담당자, 작업 요약, 작업 유형, 서버, 시작 시각, 실행 시간, CPU, 메모리, 상태를 표시
- KPI 카드: 작업 중인 사용자 수, 실행 중인 작업 수, 장시간 실행 작업 수, 작업 유형 미분류 수, 최근 수집이 없는 서버 수
- 작업 현황 필터: 사용자, 작업 유형, 서버, 상태, 실행 시간 구간, 검색어. 기본 정렬은 장시간 실행과 예외 상태 우선, 이후 CPU 사용량 내림차순
- 작업 행 선택 시 상세 drawer 제공: 사용자 이름, 작업 유형, 서버, PID, 시작 시각, 실행 시간, CPU, 메모리, 마스킹된 실행 명령 요약, 중복 실행 여부, 최근 수집 시각, 최근 상태 변경 이력
- raw command 전체는 기본 화면에 노출하지 않으며, 후속 권한 정책을 확정하기 전에는 조회 기능도 제공하지 않음
- 통계 화면 구현: 사용자별 현재 실행 작업 수, 작업 유형별 점유율, 시간대별 실행 작업 수 추이, 서버별 CPU·메모리 부하, 장시간 실행 작업 Top 10
- 예외 작업 화면 구현: 작업 유형 미분류, 장시간 실행, 중복 실행 의심, 최근 수집이 없는 서버의 작업
- 보조 화면으로 Server List, Server Detail, Snapshot History, Agent Health 구현
- process 검색, 필터, 정렬, pagination 제공
- `마지막 정상 publish`, `API 수신 후 실패`, `최근 수집 없음(stale/offline)` 상태를 분리해 표시
- collector가 API에 도달하지 못한 장애는 서버가 구체 원인을 알 수 없으므로 마지막 성공 시간 기반 stale/offline만 표시하고 추정 오류 사유를 표시하지 않음
- viewer/operator/admin별 UI 노출 범위 구분
- 미인증, 권한 거부, empty, loading, API 오류 상태 구현
- Firebase Hosting production build 배포 설정 작성

웹 클라이언트에서 snapshot, generation process, agent/server 상태 메타데이터 직접 쓰기는 허용하지 않는다.

### Phase 6. QA와 배포

- 로컬/emulator pre-staging gate: schema, Rules allow/deny matrix, repository, collector-api 통합 테스트 실행
- 10,000개 프로세스 fixture로 API 크기, 압축, 분할 batch, generation 완료 조건, fallback 정책 검증
- staging 배포
- staging P0/E2E: Hosting artifact secret scan, tenant 격리, collector push, stale/offline, Storage OFF 정상 경로 검증
- staging P0/E2E 통과 후 production 승인 및 배포

## 5. P0 릴리스 게이트

### 인증과 replay 방지

- 정상 Ed25519 서명만 저장 허용
- 본문 변조, 잘못된 키, 미등록 agent ID, 누락 또는 malformed 서명 거부
- 허용 clock skew 경계 검증
- 동일 nonce 재사용 차단
- revoked key 즉시 거부
- 키 회전 허용 창 종료 후 old key 거부

### snapshot 멱등성과 current 보호

- `snapshotId` UUIDv4 형식 검증
- create-only 저장
- 병렬 중복 요청에서도 snapshot 1건만 생성
- 동일 ID와 다른 payload conflict 처리
- 중간 batch 실패 재전송에서 누락 batch만 resume되고, `ready` 재전송은 pointer publish를 재시도하며, `published` 재전송만 no-op 성공 처리
- 실패한 요청과 오래된 snapshot이 current를 훼손하지 않음
- 지연 도착한 오래된 snapshot과 동일 `capturedAt` 충돌 snapshot이 latest pointer를 역행시키지 않음
- generation publish 완료 전 혼합 세대가 UI에 노출되지 않음
- 미완료 또는 실패 generation이 publish되지 않으며 정리 작업으로 회수됨

### 데이터 보호

- cmdline의 password, token, API key, URI credential, PEM 유사 문자열 마스킹
- 마스킹 실패 시 원문 저장보다 reject 또는 보수적 마스킹 우선
- 웹 번들, Hosting artifact, 로그, Firestore에 secret 미포함
- Cloud Storage 원본 보관 OFF 상태에서 정상 동작

### 접근 제어

- 미인증 사용자의 Firestore 읽기 거부
- 웹 클라이언트의 Firestore 직접 쓰기 거부
- 웹 클라이언트의 snapshot history Firestore 직접 읽기 거부. 서버 조회 API만 허용
- tenant 간 교차 조회 거부
- Firebase Auth 사용자와 tenant membership, viewer/operator/admin role의 연결 방식 검증
- collector-api 전용 서비스 계정 최소 권한 적용
- Admin SDK가 Rules를 우회한다는 전제에서 API 검증 별도 수행

### 운영 안정성

- systemd oneshot 중복 실행 방지
- 네트워크 timeout, 429, 5xx에 bounded retry 적용
- VM clone 의심 agent 탐지와 정책 적용
- quarantined agent 상태 변경과 latest publish 차단의 원자성 검증
- 미래 `capturedAt` poisoning 차단과 감사 후 운영자 복구 절차 검증
- TTL 삭제 지연 상태에서 만료 이력이 기본 UI에 노출되지 않음
- TTL 삭제 지연 중 만료 snapshot이 브라우저 응답에 포함되지 않음
- TTL 삭제 이후 orphan 하위 데이터가 무기한 남지 않음
- 10k fixture로 API 요청 크기, Firestore batch 한계, latency, UI pagination, 조회 비용 검증
- 10k 초과 또는 한계 초과 시 Phase 0에서 선택한 fallback 정책 검증
- byte 또는 process count 한계 초과 요청이 HTTP `413`으로 전체 reject되고 current pointer를 바꾸지 않는지 검증

## 6. 테스트 fixture

- 정상 Ed25519 keypair, revoked old key, rotated new key, 다른 agent key, malformed signature
- 정상 UUIDv4, 동일 snapshot 재전송, 동일 ID와 다른 payload, 비 UUID, 병렬 중복
- 동일 agent ID clone 2개: 동일 키 버전과 다른 키 버전
- process 0, 100, 1k, 10k
- PID 재사용, startTime 변경, 긴 cmdline, 민감정보 포함 cmdline
- TTL 만료 직전, 직후, 삭제 지연 상태
- Cloud Storage 원본 보관 ON/OFF
- gzip 허용/거부, 압축 body와 압축 해제 body 최대 크기 경계, 최대 프로세스 수 경계, HTTP `413` 전체 reject
- spool byte/file 상한, 만료, oldest-drop 또는 reject, 동일 snapshot ID 재전송
- installation instance ID 충돌, agent/key/fingerprint 조합 충돌, IP만 변경된 정상 agent
- agent registry tenant/host binding 위조, 오래된 snapshot 지연 도착, 동일 `capturedAt` 충돌, cleanup job idempotent 재실행
- batch 1/N 직후 실패, `ready` 직후 실패, pointer transaction 직후 응답 유실
- tenant/host binding 변경과 publish 동시 실행, quarantine 설정 또는 해제와 publish 동시 실행
- ready generation의 hash, process count, batch-complete 위조
- gzip 압축 해제 상한 초과, 지원하지 않는 `Content-Encoding`
- tenant B history 조회, host ID 추측, cursor 변조, membership 삭제 직후 재조회, page limit 초과
- 미래 및 과거 `capturedAt` 경계, 미래 시각 poisoning 후 정상 복구
- offline host의 오래된 current, cleanup과 ready publish 동시 실행, cleanup 재시도 중 포인터 변경
- cleanup claim 직전 및 직후 resume, `deleting` 상태 publish 시도, recursive delete 중 job 재시작
- 동일 JSON 재압축 hash 차이, spool 재전송 wire hash 동일성
- 미등록 agent, 잘못된 서명, binding 위조, 유효 agent schema 오류, 저장 실패별 host 메타데이터 변화
- host 간 cursor 재사용, filter 또는 order 변경 후 cursor 재사용, 만료 cursor, cursor signing key 회전 전후
- OS 소유주 이름 수집, 작업 유형 분류 성공·실패, 장시간 실행 경계, 동일 작업 중복 실행 의심 판정

## 7. Figma Make 적용 계획

Figma Make 기반 UI 제작은 MVP 골격 구현 이후 별도 단계로 진행한다.

초기 React 웹앱은 기능 검증이 가능한 최소 UI로 작성한다. 이후 Figma Make에서 생성한 UI를 검토하고, 필요한 컴포넌트와 스타일만 `web/`에 선택적으로 반영한다.

Figma Make UI 생성 시에도 첫 화면과 시각적 우선순위는 `현재 작업 현황`에 둔다. 서버 목록 중심 관리자 UI로 구성하지 않는다. 좌측 메뉴는 `현재 작업 현황`, `통계`, `서버 상태`, `예외 작업`, `설정` 순서로 구성하고, 실제 운영 화면과 유사한 사람별 작업 샘플 데이터를 사용한다.

권장 흐름:

```text
Figma Make에서 UI 생성
  -> Figma Make 전용 GitHub 저장소로 push
  -> 생성 코드와 라이선스 검토
  -> web/에 필요한 컴포넌트와 asset 선별 반영
  -> Firebase 연동 및 보안 테스트 재실행
```

일반 Figma Make GitHub 연동은 단방향 push이며 기존 프로젝트 저장소에 직접 push하는 방식으로 사용하지 않는다. 로컬 코드베이스 직접 편집 기능은 제한 베타이므로 기본 구현 절차에 포함하지 않는다.

## 8. 배포 원칙

- 사용자 운영 정책 값 확정 전 production 배포 금지
- schema v1, canonical signing 테스트 벡터, Firestore Rules 초안 검토 전 staging 배포 금지
- 로컬/emulator pre-staging gate 통과 전 staging 배포 금지
- staging P0/E2E 릴리스 게이트 통과 전 production 승격 금지
- 10k fixture 성능과 비용 결과 확인 전 Firestore 저장 구조 확정 금지
- Firebase Hosting artifact에 source map, `.env`, private key, 서비스 계정 JSON, collector 설정 포함 금지
- staging/prod Firebase·GCP 프로젝트와 Firebase CLI alias 분리, 오배포 방지 절차 문서화

## 9. 현재 상태

- 프로젝트 루트 지정 완료
- Firebase Hosting과 Cloud Firestore 사용 확정
- Firebase·GCP 프로젝트 base name 후보 `ssh-analyzer` 지정 완료. staging/prod 실제 ID는 배포 전 외부 입력으로 지정하고 CLI alias는 `staging`, `production`으로 확정
- Push MVP 아키텍처 확정
- QA P0 기준 확정
- Figma Make 적용은 후속 단계로 이동
- Phase 0 MVP 운영 기본값 확정. 실제 staging/prod project ID 입력은 배포 전 필요
- Phase 1 스캐폴딩과 계약 정의 완료
- Phase 2 generation repository와 Rules 정적 계약 테스트 진행 중
- 다음 작업: Firebase SDK adapter와 emulator 통합 테스트
