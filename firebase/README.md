# Firebase

Firestore Rules, index, emulator 설정을 둔다.

## Emulator

```bash
npm run test:emulator     # emulator를 띄우고 tests/emulator/*.test.js를 실행한다
```

포트는 Firestore `8085`, UI `4400`이다. 기본값 `8080`과 `4000`은 다른 로컬 서비스와 충돌하기 쉬워 옮겼다.

`firebase-tools`는 `13.x`로 고정했다. `14` 이상은 JDK `21` 이상을 요구하는데 현재 개발 환경은 JDK `17`이다. JDK `21`을 설치하면 최신 CLI로 올릴 수 있다.

emulator 테스트는 `FIRESTORE_EMULATOR_HOST`가 없으면 자동으로 skip한다. `npm test`는 emulator 없이 동작한다.

## Rules

Admin SDK는 Rules를 우회하므로 collector-api의 검증과 Rules 검증은 별개다. Rules allow/deny matrix 테스트는 웹 클라이언트를 붙이는 단계에서 추가한다.
