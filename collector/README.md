# Collector

Linux process 수집기다. systemd oneshot unit이 주기적으로 실행되며 snapshot을 서명해 collector-api로 push한다.

OS process 소유주 이름과 작업 분류용 allowlist 필드만 수집한다. raw command 전체와 환경 변수는 전송하지 않는다.

## 실행 흐름

1. lock 파일을 잡는다. 이미 실행 중이면 아무 것도 하지 않고 종료한다
2. spool 보존 기간과 상한을 적용한다
3. spool에 남은 snapshot을 오래된 것부터 재전송한다
4. `/proc`에서 현재 process를 수집한다
5. snapshot을 만들고 HTTP wire body 바이트를 고정한다
6. Ed25519로 서명해 `POST /v1/snapshots`로 보낸다
7. 재시도 가능한 실패면 wire body를 그대로 spool에 저장한다

재시도와 spool 재전송은 **최초 생성한 wire body 바이트와 `snapshotId`를 그대로 유지**하고 nonce, timestamp, signature만 새로 만든다. gzip을 다시 압축하지 않으므로 body hash가 변하지 않는다.

## 수집 필드

| 필드 | 출처 |
| --- | --- |
| `processKey` | `sha256(bootId + LF + pid + LF + startTicks)` |
| `bootId` | `/proc/sys/kernel/random/boot_id` |
| `pid`, `startTicks` | `/proc/{pid}/stat` |
| `startedAt` | `/proc/stat`의 `btime` + `startTicks / CLK_TCK` |
| `ownerName` | `/proc/{pid}` 소유 uid를 `/etc/passwd`로 변환. 없으면 `uid-{n}` |
| `executable` | `/proc/{pid}/exe`. 읽을 수 없으면 cmdline[0] 또는 comm |
| `allowedArgs` | cmdline 인자에 마스킹과 allowlist 상한 적용 |
| `workingDirectory` | `/proc/{pid}/cwd`. 읽을 수 없으면 생략 |
| `cpuPercent` | `(utime + stime) / CLK_TCK`를 프로세스 실행 시간으로 나눈 값. `ps` 의 `%CPU`와 같은 누적 평균이다 |
| `memoryBytes` | `/proc/{pid}/stat`의 RSS 페이지 수 × page size |

`taskType`은 항상 `null`, `classificationStatus`는 항상 `unclassified`로 보낸다. 작업 유형 분류는 API가 allowlist 필드로 재계산한다.

cmdline과 exe를 모두 읽을 수 없는 프로세스는 커널 스레드로 보고 건너뛴다. `INCLUDE_KERNEL_THREADS=true`로 바꿀 수 있다.

## 마스킹

- `--password=...` 처럼 민감한 키에 붙은 값은 `[redacted]`로 바꾼다
- `--password secret` 처럼 민감한 플래그 다음 인자도 `[redacted]`로 바꾼다
- `scheme://user:pass@host` 형태의 URI credential은 userinfo만 `[redacted]`로 바꾼다
- PEM 유사 문자열은 통째로 `[redacted]`로 바꾼다
- 경로가 아닌 32자 이상 불투명 문자열은 `[redacted]`로 바꾼다. 세션 ID나 토큰처럼 보이는 값은 보수적으로 지운다
- 인자는 최대 `16`개, 항목당 `256`자로 자른다

판단이 애매하면 원문을 남기지 않고 지우는 쪽을 택한다.

## 설치

```bash
sudo useradd --system --home-dir /var/lib/ssh-process-collector --shell /usr/sbin/nologin ssh-collector
sudo mkdir -p /opt/ssh-process-collector /etc/ssh-process-collector
sudo rsync -a collector contracts /opt/ssh-process-collector/

sudo -u ssh-collector openssl genpkey -algorithm ed25519 -out /var/lib/ssh-process-collector/agent-key.pem
sudo chmod 600 /var/lib/ssh-process-collector/agent-key.pem

# agent registry에 등록할 공개키. raw 32바이트를 base64url without padding으로 인코딩한다
openssl pkey -in /var/lib/ssh-process-collector/agent-key.pem -pubout -outform DER \
  | tail -c 32 | basenc --base64url | tr -d '='

sudo cp collector/.env.example /etc/ssh-process-collector/collector.env
sudo chmod 640 /etc/ssh-process-collector/collector.env

sudo cp collector/systemd/ssh-process-collector.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ssh-process-collector.timer
```

private key는 collector 실행 계정만 읽을 수 있어야 하며 저장소, 로그, 웹 번들에 포함하지 않는다.

## 환경 변수

`collector/.env.example`에 전체 목록이 있다. 최소 설정은 아래 세 가지다.

```text
API_BASE_URL=https://collector-api.example
AGENT_ID=agent_01
AGENT_KEY_ID=key_01
```

`tenantId`와 `hostId`는 서버가 agent registry에서 결정한다. collector가 지정하지 않는다.

## sudo 없이 설치

수집 대상 서버에 root 권한이 없거나 시스템 유닛을 만들기 어려우면 사용자 systemd 유닛으로 설치한다.

```bash
API_BASE_URL=http://<collector-api 주소>:8090 ./collector/scripts/install-user-units.sh
```

키 생성, 환경 파일, 유닛 파일까지 만들고 등록에 필요한 `hostId`, `agentId`, 공개키를 출력한다. private key는 그 서버를 벗어나지 않는다. 운영자가 agent를 등록한 뒤 타이머를 시작한다.

로그아웃 후에도 수집을 유지하려면 linger가 필요하다.

```bash
loginctl show-user "$USER" -p Linger
sudo loginctl enable-linger "$USER"
```

## 수집 주기와 비용

Firestore 무료 한도는 쓰기 `20,000`회/일이다. 수집 1회에 process 문서 수만큼 쓰기가 발생하므로 process `800`개 서버는 하루 약 `24`회가 상한이다. 무료로 운용하려면 타이머 주기를 `1h` 이상으로 둔다.

웹앱의 stale, warn, offline 임계값은 `60`초 수집을 기준으로 정의되어 있고, `VITE_COLLECT_INTERVAL_SECONDS`에 실제 주기를 넣으면 같은 비율로 확대된다. 이 값을 넣지 않으면 `1`시간 주기 서버가 항상 오프라인으로 표시된다.

## 개발 실행

```bash
node collector/scripts/dev-run.mjs   # 임시 API를 띄우고 실제 /proc을 한 번 수집해 결과를 출력한다
```

## 로그

구조화 JSON 한 줄씩 stdout에 남긴다. private key, 서명, nonce, snapshot body, 마스킹 전 cmdline은 기록하지 않는다.

## 미구현

- `installationInstanceId`는 생성하고 보관하지만 전송하지 않는다. snapshot schema v1에 필드가 없고 서명 대상 header에도 없어서, 전송하려면 signing 계약이나 별도 등록 엔드포인트를 먼저 확장해야 한다. 서버 측 clone 의심 판정은 그 이후에 가능하다
- host fingerprint 수집과 전송
- proxy와 사설 CA 지원. MVP 미지원으로 확정된 항목이다
