# Cleanup job과 TTL 정책

snapshot 보존 기간은 `7`일이다. 만료 데이터는 두 경로로 정리한다.

| 대상 | 정리 주체 | 이유 |
| --- | --- | --- |
| `tenants/{t}/hosts/{h}/snapshots/{snapshotId}` | Firestore TTL policy | 하위 컬렉션이 없어 문서 삭제만으로 충분하다 |
| `tenants/{t}/hosts/{h}/generations/{snapshotId}`와 하위 `processes` | scheduled cleanup job | TTL 삭제는 하위 컬렉션을 지우지 않아 orphan이 남는다 |

`expiresAt`은 서버가 수신 시각과 보존 정책으로 계산해 generation과 snapshot history 양쪽에 기록한다. collector가 보낸 값은 쓰지 않는다.

## TTL policy 설정

snapshot history 문서의 `expiresAt` 필드에 TTL을 건다.

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=snapshots --enable-ttl --project="$GOOGLE_CLOUD_PROJECT"
```

`firebase/firestore.indexes.json`의 `fieldOverrides`가 `snapshots.expiresAt`의 인덱스를 비워 둔다. TTL 필드는 인덱스 예외를 적용하는 것이 권장 설정이고, 그래서 history 조회는 `expiresAt`이 아니라 인덱스가 있는 `capturedAt >= retentionCutoff`로 범위를 좁힌 뒤 만료 문서를 서버에서 걸러낸다.

TTL 삭제는 지연될 수 있다. history 조회 API는 지연된 만료 문서를 응답에 넣지 않는다.

## Cleanup job

```bash
node collector-api/scripts/cleanup.mjs
```

동작은 다음과 같다.

1. `expiresAt <= now`인 generation을 실행당 최대 `100`개까지 조회한다
2. 각 대상을 `deleting` 상태로 claim한다. 현재 `publishedGeneration`, `ready`, `publishing`, 유효한 resume lease는 claim 단계에서 거부되며 건너뛴 것으로 집계한다
3. process를 트랜잭션 밖에서 `400`개 청크로 재귀 삭제한 뒤 generation 메타데이터를 지운다
4. 중간에 실패해도 claim이 남아 있어 다음 실행이 같은 대상을 이어서 정리한다
5. `15`분 timeout에 도달하면 남은 대상을 다음 실행으로 넘긴다

장기 offline host의 current generation은 만료되어도 삭제하지 않는다. 매 실행에서 건너뛴 것으로 집계되며 이는 정상 동작이다.

## Cloud Run job 배포

cleanup 전용 service account를 쓰고 collector-api runtime service account와 분리한다.

```bash
gcloud run jobs deploy ssh-analyzer-cleanup \
  --source . \
  --command node --args collector-api/scripts/cleanup.mjs \
  --service-account cleanup@"$GOOGLE_CLOUD_PROJECT".iam.gserviceaccount.com \
  --set-env-vars STORAGE_DRIVER=firestore,GOOGLE_CLOUD_PROJECT="$GOOGLE_CLOUD_PROJECT" \
  --task-timeout 15m --max-retries 3 --region asia-northeast3

gcloud scheduler jobs create http ssh-analyzer-cleanup-hourly \
  --schedule "0 * * * *" --location asia-northeast3 \
  --uri "https://asia-northeast3-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$GOOGLE_CLOUD_PROJECT/jobs/ssh-analyzer-cleanup:run" \
  --http-method POST --oauth-service-account-email scheduler@"$GOOGLE_CLOUD_PROJECT".iam.gserviceaccount.com
```

실행 결과는 구조화 로그 `cleanup-summary`로 남는다. `failed`가 0이 아니면 job이 실패 종료 코드를 반환한다.
