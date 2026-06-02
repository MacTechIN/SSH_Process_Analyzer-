# Phase 0 운영 정책 결정표

2026-06-02 기준 MVP 운영 정책이다. 실제 Firebase 프로젝트 ID 두 개만 외부 입력이 필요하며, 나머지 값은 구현 기본값으로 확정한다.

## 환경

| 항목 | 결정값 | 상태 |
| --- | --- | --- |
| staging GCP/Firebase project ID | 사용자 지정 필요 | 외부 입력 필요 |
| staging Firebase CLI alias | `staging` | 확정 |
| production GCP/Firebase project ID | 사용자 지정 필요 | 외부 입력 필요 |
| production Firebase CLI alias | `production` | 확정 |
| GCP region | `asia-northeast3` (Seoul) | 확정 |
| Firestore database | `(default)` | 확정 |
| 로그인 방식 | Firebase Auth Google Sign-In | 확정 |
| tenant 권한 원본 | `tenants/{tenantId}/memberships/{uid}` | 확정 |
| role | `viewer`, `operator`, `admin`; MVP 웹 쓰기는 모두 금지 | 확정 |

staging과 production은 반드시 별도 GCP/Firebase 프로젝트를 사용한다. 프로젝트 ID는 저장소에 임의 값을 넣지 않고 배포 환경에서 주입한다.

## 수집 범위와 분류

| 항목 | 결정값 | 상태 |
| --- | --- | --- |
| 용량 계획 | 최대 서버 `100`, 서버당 평균 process `500`, 최대 process `10,000` | 확정 |
| collector 주기 | `60`초 | 확정 |
| 지원 Linux | Ubuntu `22.04 LTS`, `24.04 LTS`, systemd 환경 | 확정 |
| proxy, 사설 CA | MVP 미지원 | 확정 |
| 화면 사용자 이름 | process OS 소유주 이름 `ownerName` 그대로 사용 | 확정 |
| process 안정 키 | `sha256(bootId + LF + pid + LF + startTicks)` lowercase hex | 확정 |
| 작업 유형 분류 | API가 `executable`, allowlisted `allowedArgs`, `workingDirectory` 규칙으로 재계산 | 확정 |
| 분류 실패 | `classificationStatus=unclassified`, `taskType=null` | 확정 |
| raw command와 env | 저장, 로그, 브라우저 전달 금지 | 확정 |
| 장시간 실행 | `startedAt` 기준 `24`시간 이상 | 확정 |
| 중복 실행 의심 | 같은 host에서 `ownerName + taskType + executable`이 동일한 current process가 `2`개 이상 | 확정 |

분류 규칙 allowlist의 실제 업무 패턴은 운영 샘플을 받은 뒤 별도 설정 파일로 추가한다. 패턴이 없더라도 모든 process는 `unclassified` fallback으로 안전하게 처리한다.

## 필드 제한

| 필드 | 최대 길이 또는 형식 |
| --- | --- |
| `tenantId`, `hostId`, `agentId`, `kid` | `[A-Za-z0-9_-]{1,128}` |
| `snapshotId` | UUIDv4 lowercase |
| `processKey` | SHA-256 lowercase hex `64`자 |
| `bootId` | UUID lowercase |
| `ownerName` | `[A-Za-z0-9_.-]{1,128}` |
| `executable` | UTF-8 `512`자 |
| `allowedArgs` | 최대 `16`개, 항목당 UTF-8 `256`자 |
| `workingDirectory` | UTF-8 `1024`자 |
| `taskType` | UTF-8 `128`자 |
| `X-Correlation-Id` | `[A-Za-z0-9._-]{1,128}`, 부적합하면 서버 생성 UUID로 교체 |

## 보안과 재전송

| 항목 | 결정값 | 상태 |
| --- | --- | --- |
| replay clock skew | 수신 시각 기준 과거·미래 `5`분 | 확정 |
| replay nonce TTL | `24`시간 | 확정 |
| `capturedAt` 미래 허용 skew | API 수신 시각 기준 `5`분 | 확정 |
| spool 과거 허용 기간 | `24`시간 | 확정 |
| offline backlog | 허용 | 확정 |
| spool 상한 | `100 MiB`, `1,000` files, 파일별 최대 `8 MiB`, `24`시간 만료 | 확정 |
| spool 초과 정책 | oldest-drop 후 metric과 로그 기록 | 확정 |
| clone 의심 | installation instance ID 충돌 또는 agent/key/fingerprint 조합 충돌 | 확정 |
| quarantine 해제 | 자동 해제 금지, admin 수동 해제와 감사 로그 필수 | 확정 |
| 미래 시각 poisoning 복구 | 해당 agent quarantine, host pointer 확인, 잘못된 generation 비publish 확인 후 admin 수동 해제 | 확정 |

## API와 저장

| 항목 | 결정값 | 상태 |
| --- | --- | --- |
| 허용 `Content-Encoding` | `identity`, `gzip` | 확정 |
| HTTP wire body 상한 | `8 MiB` | 확정 |
| 압축 해제 body 상한 | `16 MiB` | 확정 |
| 서버당 최대 process 수 | `10,000` | 확정 |
| byte 또는 process 수 초과 | HTTP `413` 전체 reject, truncate 금지 | 확정 |
| snapshot 보존 기간 | `7`일 | 확정 |
| stale 기준 | 마지막 정상 publish 후 `2`분 | 확정 |
| warn 기준 | 마지막 정상 publish 후 `5`분 | 확정 |
| offline 기준 | 마지막 정상 publish 후 `15`분 | 확정 |
| Firestore write batch | process `400`개 단위 | 확정 |
| generation ready 조건 | 모든 batch 성공, manifest 완료, expected process count 일치 | 확정 |
| `10,000`개 snapshot | 최대 `25`개 batch로 분할 publish | 확정 |

## Cleanup job

| 항목 | 결정값 | 상태 |
| --- | --- | --- |
| 실행 주기 | `1`시간 | 확정 |
| 실행 주체 | scheduled Cloud Run job, cleanup 전용 service account | 확정 |
| 실행당 삭제 상한 | generation `100`개 | 확정 |
| timeout | `15`분 | 확정 |
| 재시도 | 최대 `3`회 exponential backoff | 확정 |
| 실패 처리 | metric, 구조화 로그, 운영 알림 | 확정 |
| 삭제 규칙 | current pointer, `ready`, `publishing`, 유효 resume lease 제외 후 `deleting` claim | 확정 |

## 남은 외부 입력

배포 전에 아래 두 값만 확정한다.

```text
STAGING_GOOGLE_CLOUD_PROJECT=
PRODUCTION_GOOGLE_CLOUD_PROJECT=
```
