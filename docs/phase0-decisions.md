# Phase 0 운영 정책 결정표

Phase 1 계약 파일에는 합의된 구조만 고정한다. 아래 값은 구현 전에 확정한다.

| 항목 | 결정값 | 상태 |
| --- | --- | --- |
| staging GCP/Firebase project ID와 CLI alias | TBD | 미정 |
| production GCP/Firebase project ID와 CLI alias | TBD | 미정 |
| GCP region | TBD | 미정 |
| 서버 수, 평균 및 최대 process 수 | TBD | 미정 |
| collector 주기 | TBD | 미정 |
| process 필드별 최대 길이 | TBD | 미정 |
| 작업 유형 분류 allowlist와 규칙 | TBD | 미정 |
| 장시간 실행 기준 | TBD | 미정 |
| 중복 실행 의심 기준 | TBD | 미정 |
| replay clock skew와 TTL | TBD | 미정 |
| capturedAt 미래 skew와 spool 과거 허용 기간 | TBD | 미정 |
| offline backlog와 spool 상한 | TBD | 미정 |
| snapshot 보존 기간 | TBD | 미정 |
| stale, warn, offline 기준 | TBD | 미정 |
| API wire body 상한 | TBD | 미정 |
| gzip 허용 여부와 압축 해제 body 상한 | TBD | 미정 |
| 최대 process 수 초과 정책 | reject 또는 truncate | 미정 |
| Firestore write batch 크기 | TBD | 미정 |
| 로그인 방식과 role별 tenant 접근 범위 | TBD | 미정 |
| cleanup job 주기, 삭제 상한, timeout, retry | TBD | 미정 |

화면 사용자 이름은 별도 매핑 없이 process OS 소유주 이름을 그대로 사용한다.
