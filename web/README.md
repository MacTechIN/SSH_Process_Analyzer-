# Web

React 조회 전용 웹앱이다. Firebase Hosting에 배포하고 Firestore를 직접 읽는다.

## 화면

| 화면 | 내용 |
| --- | --- |
| 현재 작업 현황 | 첫 화면. KPI 카드 5개, 필터, 작업 표, 선택 시 상세 drawer |
| 통계 | 사용자별 작업 수, 작업 유형 점유율, 시간대별 시작 추이, 서버별 부하, 장시간 실행 Top 10 |
| 서버 상태 | 서버 목록과 상세, Snapshot History, 마지막 정상 publish와 API 수신 후 실패 분리 표시 |
| 예외 작업 | 장시간 실행, 중복 실행 의심, 미분류, 최근 수집 없는 서버의 작업 |
| 설정 | tenant, 자동 새로고침 간격, 세션과 role 표시 |

기본 정렬은 장시간 실행과 예외 상태 우선, 그다음 CPU 내림차순이다.

## 데이터 경로

- 현재 작업: Firestore에서 host 문서와 `publishedGeneration`이 가리키는 process만 읽는다
- snapshot history: Firestore 직접 읽기가 Rules로 막혀 있어 collector-api의 조회 API를 쓴다. `VITE_HISTORY_API_BASE_URL`이 없으면 해당 화면만 미설정 안내를 표시한다
- 쓰기는 어떤 경로로도 하지 않는다

실시간 구독을 쓰지 않는다. collector가 push할 때마다 모든 process 문서를 다시 읽으면 Firestore 무료 할당량을 빠르게 소진하기 때문에, 화면 진입과 새로고침 시점에만 읽는다. 자동 새로고침은 기본값이 꺼져 있다.

## 표시 제한

- raw command 전체와 환경 변수는 애초에 수집하지 않으며 화면에도 없다. 실행 파일과 마스킹된 allowlist 인자만 표시한다
- agent 등록 정보와 quarantine 상태는 Rules에서 막혀 있어 웹에서 조회할 수 없다. 운영 CLI로 확인한다
- role은 표시와 일부 필드 노출에만 쓰고 권한 판단은 Rules와 서버 API가 한다

## 개발

```bash
npm --prefix web install
npm --prefix web run dev      # http://localhost:5173
npm run build:web             # 프로덕션 번들
npm run verify:web            # Hosting 아티팩트 비밀 정보 검사
```

`web/.env` 값은 [docs/deploy-web.md](../docs/deploy-web.md)를 참고한다.

화면 로직은 `web/src/lib/`에 순수 함수로 분리되어 있고 `tests/unit/web-*.test.js`가 검증한다. Figma UI는 이후 단계에서 선별 반영한다.
