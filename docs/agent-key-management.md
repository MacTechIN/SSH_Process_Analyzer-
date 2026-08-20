# Agent 키 관리 절차

collector agent의 등록, 키 회전, 회수, quarantine 절차다. 모든 명령은 감사 로그를 남긴다.

## 도구

```bash
node collector-api/scripts/agent-admin.mjs help
```

`STORAGE_DRIVER`와 `GOOGLE_CLOUD_PROJECT`가 가리키는 저장소에 직접 쓴다. production 대상 실행은 cleanup과 분리된 운영자 자격 증명으로 수행한다.

## 식별자 규칙

- `agentId`는 **모든 tenant를 통틀어 유일**해야 한다. 서명 payload에 `tenantId`가 없어 서버가 `agentId`만으로 tenant를 결정하기 때문이다
- 중복 등록은 등록 단계에서 `AGENT_ALREADY_REGISTERED`로 막고, 이미 중복된 상태면 수집 API가 `AGENT_ID_NOT_UNIQUE`와 HTTP `503`으로 fail-closed 처리한다
- `agentId`, `kid`, `tenantId`, `hostId`는 `[A-Za-z0-9_-]{1,128}`

## 1. 키 생성과 등록

키는 대상 호스트에서 만들고 private key는 호스트를 떠나지 않는다.

```bash
# 수집 대상 호스트에서
sudo -u ssh-collector openssl genpkey -algorithm ed25519 -out /var/lib/ssh-process-collector/agent-key.pem
sudo chmod 600 /var/lib/ssh-process-collector/agent-key.pem
openssl pkey -in /var/lib/ssh-process-collector/agent-key.pem -pubout -outform DER \
  | tail -c 32 | basenc --base64url | tr -d '='

# 운영자 워크스테이션에서
node collector-api/scripts/agent-admin.mjs register \
  --tenant acme --host web-01 --agent agent_web01 --kid key_2026_08 \
  --public-key <위에서 출력한 공개키> --actor ops@example.com
```

등록은 host 문서가 없으면 만들고, 이미 있으면 publish 포인터를 건드리지 않는다.

## 2. 키 회전

새 키를 먼저 등록해 겹치는 기간을 두고, collector 설정을 바꾼 뒤 옛 키를 회수한다.

```bash
# 1) 새 키 등록. 이 시점에는 두 키가 모두 유효하다
node collector-api/scripts/agent-admin.mjs rotate-key \
  --agent agent_web01 --kid key_2026_11 --public-key <새 공개키> --actor ops@example.com

# 2) 호스트의 AGENT_KEY_ID를 새 kid로 바꾸고 collector를 한 번 실행해 성공을 확인한다
sudo systemctl start ssh-process-collector.service
journalctl -u ssh-process-collector.service -n 20

# 3) 옛 키 회수
node collector-api/scripts/agent-admin.mjs revoke-key \
  --agent agent_web01 --kid key_2026_08 --actor ops@example.com
```

- 회수된 키로 들어온 요청은 즉시 HTTP `401` `REVOKED_KEY`다
- 마지막 남은 활성 키는 회수할 수 없다. 먼저 대체 키를 등록해야 한다
- 회전 중 spool에 쌓인 snapshot은 재전송 시 새 키로 다시 서명되므로 그대로 복구된다

## 3. Quarantine

clone 의심이나 미래 시각 poisoning처럼 신뢰를 확인해야 하는 상황에서 사용한다. quarantine 상태에서는 publish transaction이 원자적으로 차단되어 latest pointer가 움직이지 않는다.

```bash
node collector-api/scripts/agent-admin.mjs quarantine \
  --agent agent_web01 --reason "installation instance id collision" --actor ops@example.com

node collector-api/scripts/agent-admin.mjs describe --agent agent_web01
```

해제는 자동으로 일어나지 않는다. 운영자와 사유가 모두 있어야 하고 감사 로그에 남는다.

```bash
node collector-api/scripts/agent-admin.mjs release \
  --agent agent_web01 --reason "host rebuilt and key rotated" --actor ops@example.com
```

### 미래 시각 poisoning 복구 순서

1. 해당 agent를 quarantine 한다
2. host의 `publishedGeneration`과 `publishedCapturedAt`을 확인한다
3. 잘못된 미래 시각 generation이 publish되지 않았는지 확인한다. `capturedAt` 검증은 수신 시각 기준 `5`분을 넘는 요청을 history 저장 전에 거부한다
4. 호스트 시계를 교정하고 collector를 재실행해 정상 snapshot을 확인한다
5. 사유를 적어 quarantine을 해제한다

## 4. 감사 로그

`describe`가 등록, 회전, 회수, quarantine, 해제 이력을 시간순으로 보여준다. Firestore에서는 `tenants/{tenantId}/agents/{agentId}/auditLog`에 쌓이며 웹 클라이언트에서는 읽을 수 없다.
