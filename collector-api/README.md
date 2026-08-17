# Collector API

Cloud Run snapshot 수신 API를 구현할 위치다.

서명 검증, replay 차단, registry binding, generation publish transaction, history 조회 API를 포함한다.

현재 `src/repository/`에는 generation 상태 전이를 검증하기 위한 repository와 in-memory transaction adapter가 있다. Firebase SDK adapter는 emulator 통합 테스트와 함께 추가한다.

in-memory adapter는 Firestore 트랜잭션 제약을 그대로 강제한다. 트랜잭션의 모든 읽기는 모든 쓰기보다 앞서야 하고, 트랜잭션과 write batch는 각각 `500` write를 넘을 수 없다. process 재귀 삭제는 트랜잭션 밖에서 `limits.js`의 청크 크기로 나눠 수행한다. 이 제약을 지키면 Firebase SDK adapter는 동일 인터페이스 구현으로 교체할 수 있다.
