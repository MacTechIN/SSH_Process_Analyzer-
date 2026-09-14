# maindev 이관 절차

수집 API와 cleanup job을 `maindev`로 옮기고, 기존 서버는 수집기만 남긴다. 저장소 위치는 `~/workspace/ssh_process_mgmt`다.

## 이관 후 구성

```text
jnh-MS-7C94 (100.83.34.122)          maindev (100.101.238.106)
  collector (systemd timer)  ──push──▶  collector-api (systemd service)
                                         collector (자기 자신도 수집)
                                         cleanup job (1시간 타이머)
                                              │
                                              ▼
                                         Cloud Firestore ─▶ ssh-analyzer.web.app
```

Firebase 프로젝트, Rules, 웹앱은 그대로 둔다. 바뀌는 것은 API가 실행되는 위치와 collector가 바라보는 주소다.

## 0. 사전 확인

클론 후 `maindev`에서 점검 스크립트를 돌린다. 아무것도 설치하거나 바꾸지 않고 조건만 확인한다.

```bash
./scripts/preflight-host.sh
```

node 버전, systemd 사용자 세션과 linger, tailscale 주소, 포트 충돌, service account 키 권한, 예상 수집량과 하루 쓰기 횟수를 확인하고 실패 항목이 있으면 종료 코드 `1`을 반환한다.

개별 확인은 아래와 같다.

```bash
node --version      # v20 이상
git --version
openssl version
loginctl show-user "$USER" -p Linger    # Linger=yes 여야 로그아웃 후에도 유지된다
tailscale ip -4                          # 100.101.238.106 인지 확인
```

`Linger=no`면 아래를 한 번 실행한다. 이 명령만 sudo가 필요하다.

```bash
sudo loginctl enable-linger "$USER"
```

## 1. 저장소 클론

```bash
mkdir -p ~/workspace
git clone https://github.com/MacTechIN/SSH_Process_Analyzer-.git ~/workspace/ssh_process_mgmt
cd ~/workspace/ssh_process_mgmt
npm ci
npm test              # 117개 통과해야 한다
```

## 2. service account 키 배치

**권장: maindev 전용 키를 새로 발급한다.** 기존 키를 복사하면 한 키가 두 장비에 존재하고, 유출 시 회수 범위가 넓어진다.

1. https://console.firebase.google.com/project/ssh-analyzer/settings/serviceaccounts/adminsdk
2. **Generate new private key** → JSON 다운로드
3. `maindev`에 배치

```bash
mkdir -p ~/.secrets && chmod 700 ~/.secrets
mv ~/Downloads/ssh-analyzer-*.json ~/.secrets/ssh-analyzer-admin.json
chmod 600 ~/.secrets/ssh-analyzer-admin.json
```

기존 키를 그대로 옮기려면 Taildrop을 쓴다. 파일이 tailnet 밖으로 나가지 않는다.

```bash
# jnh-MS-7C94 에서
tailscale file cp ~/.secrets/ssh-analyzer-admin.json maindev:
# maindev 에서
tailscale file get ~/.secrets/ && chmod 600 ~/.secrets/ssh-analyzer-admin.json
```

이관이 끝나면 더 쓰지 않는 키는 콘솔에서 삭제한다.

## 3. collector-api 설치

```bash
cd ~/workspace/ssh_process_mgmt
GOOGLE_CLOUD_PROJECT=ssh-analyzer \
GOOGLE_APPLICATION_CREDENTIALS=$HOME/.secrets/ssh-analyzer-admin.json \
BIND_HOST=100.101.238.106 \
./collector-api/scripts/install-user-units.sh
```

API 서비스와 cleanup 타이머가 함께 등록된다. `BIND_HOST`를 Tailscale 주소로 두었으므로 LAN과 공인 인터페이스에서는 열리지 않는다.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://100.101.238.106:8090/healthz   # 200
```

## 4. maindev 자신을 수집 대상으로 추가

```bash
API_BASE_URL=http://100.101.238.106:8090 COLLECT_INTERVAL=2h \
  ./collector/scripts/install-user-units.sh
```

출력된 `hostId`, `agentId`, 공개키로 agent를 등록한다. 키가 이미 maindev에 있으므로 등록도 여기서 바로 할 수 있다.

```bash
export GOOGLE_CLOUD_PROJECT=ssh-analyzer
export GOOGLE_APPLICATION_CREDENTIALS=$HOME/.secrets/ssh-analyzer-admin.json

node collector-api/scripts/agent-admin.mjs register \
  --tenant default --host maindev --agent agent_maindev --kid key_01 \
  --public-key <출력된 공개키> --actor wooriszhome@gmail.com

systemctl --user start ssh-process-collector.timer
systemctl --user start ssh-process-collector.service
journalctl --user -u ssh-process-collector.service -n 10
```

## 5. 기존 서버를 maindev API로 전환

`jnh-MS-7C94`에서 실행한다. agent 등록 정보는 그대로 쓰고 바라보는 주소만 바꾼다.

```bash
sed -i 's|^API_BASE_URL=.*|API_BASE_URL=http://100.101.238.106:8090|' \
  ~/.config/ssh-process-collector/collector.env

# 수집 주기를 2시간으로 맞춘다
sed -i 's|^OnUnitActiveSec=.*|OnUnitActiveSec=2h|' \
  ~/.config/systemd/user/ssh-process-collector.timer

systemctl --user daemon-reload
systemctl --user restart ssh-process-collector.timer
systemctl --user start ssh-process-collector.service      # 즉시 1회 확인
journalctl --user -u ssh-process-collector.service -n 10  # published:true 확인

# 이 서버의 API와 cleanup은 더 이상 필요 없다
systemctl --user disable --now ssh-process-collector-api.service
```

## 6. 수집 주기 재계산

Firestore 무료 한도는 쓰기 `20,000`회/일이다. 수집 1회에 process 문서 수만큼 쓰기가 발생한다.

| 구성 | 수집 주기 | 하루 쓰기 | 무료 한도 대비 |
| --- | --- | --- | --- |
| 1대 (`803` proc) | `1h` | 약 `18,500` | `92%` |
| 2대 (`803` + `500` proc) | `1h` | 약 `31,300` | **`156%` 초과** |
| 2대 | `2h` | 약 `15,600` | `78%` |
| 2대 | `3h` | 약 `10,400` | `52%` |

서버가 두 대가 되면 `1h` 주기로는 한도를 넘는다. **두 대 모두 `2h`** 로 두는 것을 기준으로 한다. maindev의 실제 process 수를 확인한 뒤 다시 계산한다.

```bash
# maindev의 process 수 확인
journalctl --user -u ssh-process-collector.service -n 5 -o cat | grep processCount
```

주기를 바꾸면 웹앱의 상태 임계값도 함께 바꾼다. 그러지 않으면 모든 서버가 오프라인으로 표시된다.

```bash
# 웹앱을 배포하는 장비에서
sed -i 's|^VITE_COLLECT_INTERVAL_SECONDS=.*|VITE_COLLECT_INTERVAL_SECONDS=7200|' web/.env
npm run deploy:web
```

## 7. history API를 웹앱에 연결 (선택)

웹앱은 HTTPS이고 API는 평문 HTTP라, 브라우저가 mixed content로 차단한다. Tailscale Serve로 tailnet 안에서 HTTPS 종단을 만들면 연결할 수 있다.

```bash
# maindev 에서
tailscale serve --bg --https 443 http://127.0.0.1:8090
tailscale serve status
```

그러면 `https://maindev.tail15f112.ts.net`으로 접근된다. 이 주소를 웹앱에 넣고 재배포한다.

```bash
sed -i 's|^VITE_HISTORY_API_BASE_URL=.*|VITE_HISTORY_API_BASE_URL=https://maindev.tail15f112.ts.net|' web/.env
npm run deploy:web
```

tailnet에 들어와 있는 기기에서만 동작한다. `tailscale funnel`로 공개하면 인터넷에 노출되므로 쓰지 않는다.

## 8. 이관 확인

```bash
# maindev
systemctl --user is-active ssh-process-collector-api.service
systemctl --user list-timers 'ssh-process-collector*' --no-pager

# 두 호스트가 모두 보이는지 확인
node -e '
import("./collector-api/src/repository/firestore-store.js").then(async (m) => {
  const store = new m.FirestoreStore(m.createFirestore({ projectId: "ssh-analyzer" }));
  for (const hostId of ["jnh-MS-7C94", "maindev"]) {
    const host = await store.readHost("default", hostId);
    console.log(hostId, host?.publishedCapturedAt ?? "수집 기록 없음", host?.lastOutcome ?? "-");
  }
  process.exit(0);
});'
```

웹앱 `서버 상태` 화면에 두 대가 모두 나오면 이관 완료다.

## 롤백

기존 서버의 설정만 되돌리면 된다. Firestore 데이터는 공유되므로 유실이 없다.

```bash
# jnh-MS-7C94
sed -i 's|^API_BASE_URL=.*|API_BASE_URL=http://100.83.34.122:8090|' \
  ~/.config/ssh-process-collector/collector.env
systemctl --user enable --now ssh-process-collector-api.service
systemctl --user restart ssh-process-collector.timer

# maindev
systemctl --user disable --now ssh-process-collector-api.service ssh-process-collector.timer
```
