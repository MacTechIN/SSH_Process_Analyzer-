# Integration Tests

Firestore emulator 기반 tenant 격리와 Rules allow/deny matrix 테스트를 추가할 위치다.

Phase 2에서는 `firebase/firebase.json`으로 emulator 포트를 고정하고, Rules의 핵심 불변식은 `tests/unit/firestore-rules-contract.test.js`에서 정적으로 검증한다. Firebase CLI와 테스트 SDK 의존성은 실제 emulator 연동 작업에서 추가한다.
