# Firebase

- `firestore.rules`: tenant membership 기반 조회 전용 Rules 초안
- `firestore.indexes.json`: snapshot history 서버 API용 index와 TTL field exemption 초안

서버 SDK는 Firestore Rules를 우회하므로 collector API와 cleanup job은 별도 애플리케이션 allowlist와 최소 IAM을 적용한다.
