# Data Model v1

## Firestore 경로

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

## 현재 상태

host 문서의 `publishedGeneration` 포인터가 가리키는 generation만 웹의 현재 상태로 취급한다. generation은 `staging`, `failed-retryable`, `ready`, `publishing`, `published`, `deleting` 상태를 가진다.

## 사용자와 작업

- 화면 사용자 이름과 사용자별 통계 기준은 process의 `ownerName`이다.
- `ownerName`은 OS process 소유주 이름이다. MVP에서는 별도 사용자 매핑을 하지 않는다.
- `processKey`는 `sha256(bootId + LF + pid + LF + startTicks)` lowercase hex다. raw command를 안정 키 입력으로 사용하지 않는다.
- 작업 유형은 allowlist 필드로 분류하며 분류할 수 없으면 `classificationStatus=unclassified`로 기록한다.
- API는 collector가 보낸 분류 결과를 신뢰하지 않고 allowlist 필드로 다시 계산한다.
- raw command 전체와 환경 변수는 저장하거나 브라우저에 전달하지 않는다.

## 읽기 경계

- Web SDK는 membership이 허용된 tenant의 host와 현재 generation process만 읽는다.
- snapshot history는 Web SDK로 직접 읽지 않고 Firebase Auth ID token을 검증하는 서버 API로 조회한다.
- 웹 클라이언트 쓰기는 모두 금지한다.
