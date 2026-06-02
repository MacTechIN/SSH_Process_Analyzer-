# Collector API

Cloud Run snapshot 수신 API를 구현할 위치다.

서명 검증, replay 차단, registry binding, generation publish transaction, history 조회 API를 포함한다.

현재 `src/repository/`에는 generation 상태 전이를 검증하기 위한 repository와 in-memory transaction adapter가 있다. Firebase SDK adapter는 emulator 통합 테스트와 함께 추가한다.
