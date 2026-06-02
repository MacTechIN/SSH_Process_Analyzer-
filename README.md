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

현재는 계약 정의 단계이므로 실행 가능한 애플리케이션은 아직 없다.

구현 완료 후 기본 흐름은 다음과 같다.

1. Linux 서버에 collector와 systemd timer를 설치한다.
2. collector가 process snapshot을 수집하고 서명하여 API로 전송한다.
3. API가 검증을 통과한 snapshot을 Firestore에 publish한다.
4. 사용자는 웹 대시보드에서 OS process 소유주별 현재 작업과 통계를 확인한다.

## 개발 상태

현재 단계: `Phase 1 - 스캐폴딩과 계약 정의`

- 완료: monorepo 기본 구조
- 완료: snapshot JSON Schema v1
- 완료: canonical signing v1과 replay fixture
- 완료: Firestore Rules와 index 초안
- 완료: OS process 소유주 기준 통계 계약
- 진행 전: Phase 0 운영 정책 값 확정
- 진행 전: collector, API, web 실제 구현
- 추후 반영: Figma 파일 기반 UI 컴포넌트와 스타일

운영 정책 미정값은 [docs/phase0-decisions.md](docs/phase0-decisions.md), 전체 구현 계획은 [implement.md](implement.md)에서 관리한다.

## 개발 진행 기록

진행 기록은 시계열로 누적한다. 기존 기록을 수정하거나 덮어쓰기보다 새 항목을 아래에 추가한다.

### 2026-06-02 - v0.1.0

- 프로젝트 저장소 초기화
- MVP 목적을 OS process 소유주별 현재 작업 현황과 통계 조회로 확정
- Phase 1 기본 디렉터리 생성
- snapshot, signing, analytics 계약 추가
- Firestore Rules, index, env 예시 추가
- Figma 파일은 추후 제공 후 선별 반영 예정

## 참고 문서

- [데이터 모델 v1](docs/data-model-v1.md)
- [Phase 0 운영 정책 결정표](docs/phase0-decisions.md)
- [Snapshot Schema v1](contracts/snapshot-v1.schema.json)
- [Canonical Signing v1](contracts/signing-v1.md)
- [Analytics v1](contracts/analytics-v1.md)
