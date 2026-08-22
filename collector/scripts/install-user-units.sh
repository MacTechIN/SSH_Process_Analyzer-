#!/usr/bin/env bash
# sudo 없이 사용자 systemd 유닛으로 collector를 설치한다.
# 수집 대상 서버에서 실행한다. private key는 이 서버에서 만들어지고 밖으로 나가지 않는다.
#
#   API_BASE_URL=http://100.83.34.122:8090 ./collector/scripts/install-user-units.sh
#
# 실행이 끝나면 출력되는 공개키와 hostId를 운영자에게 전달해 agent 등록을 요청한다.
set -euo pipefail

API_BASE_URL="${API_BASE_URL:?API_BASE_URL을 지정하세요. 예: http://100.83.34.122:8090}"
COLLECT_INTERVAL="${COLLECT_INTERVAL:-1h}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

HOST_ID="${HOST_ID:-$(hostname -s | tr -c 'A-Za-z0-9_-' '-' | sed 's/-*$//')}"
AGENT_ID="${AGENT_ID:-agent_$(echo "$HOST_ID" | tr 'A-Z-' 'a-z_')}"
KID="${KID:-key_01}"

SECRET_DIR="${SECRET_DIR:-$HOME/.secrets}"
CONFIG_DIR="$HOME/.config/ssh-process-collector"
UNIT_DIR="$HOME/.config/systemd/user"
KEY_PATH="$SECRET_DIR/collector-agent-key.pem"

if [ -z "$NODE_BIN" ]; then
  echo "node를 찾을 수 없습니다. Node 20 이상을 설치하고 NODE_BIN을 지정하세요." >&2
  exit 1
fi

umask 077
mkdir -p "$SECRET_DIR" "$CONFIG_DIR" "$UNIT_DIR"
chmod 700 "$SECRET_DIR"

if [ ! -f "$KEY_PATH" ]; then
  openssl genpkey -algorithm ed25519 -out "$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi

cat > "$CONFIG_DIR/collector.env" <<EOF
API_BASE_URL=$API_BASE_URL
AGENT_ID=$AGENT_ID
AGENT_KEY_ID=$KID
AGENT_PRIVATE_KEY_PATH=$KEY_PATH
STATE_DIR=$HOME/.local/state/ssh-process-collector
EOF
chmod 600 "$CONFIG_DIR/collector.env"

cat > "$UNIT_DIR/ssh-process-collector.service" <<EOF
[Unit]
Description=SSH Process Analyzer collector (oneshot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
EnvironmentFile=$CONFIG_DIR/collector.env
ExecStart=$NODE_BIN collector/src/index.js
TimeoutStartSec=180
NoNewPrivileges=yes
PrivateTmp=yes
EOF

cat > "$UNIT_DIR/ssh-process-collector.timer" <<EOF
[Unit]
Description=Run the SSH Process Analyzer collector every $COLLECT_INTERVAL

[Timer]
OnBootSec=5min
OnUnitActiveSec=$COLLECT_INTERVAL
AccuracySec=1min
RandomizedDelaySec=2min
Persistent=true
Unit=ssh-process-collector.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable ssh-process-collector.timer >/dev/null

PUBLIC_KEY="$(openssl pkey -in "$KEY_PATH" -pubout -outform DER | tail -c 32 | basenc --base64url | tr -d '=')"

cat <<EOF

설치 완료. agent 등록 전에는 push가 401로 거부되므로 타이머는 아직 시작하지 않았다.

운영자에게 아래 세 값을 전달한다. 공개키는 비밀이 아니다.

  hostId      : $HOST_ID
  agentId     : $AGENT_ID
  kid         : $KID
  public key  : $PUBLIC_KEY

등록이 끝나면 아래로 시작한다.

  systemctl --user start ssh-process-collector.timer
  systemctl --user start ssh-process-collector.service   # 즉시 1회 수집
  journalctl --user -u ssh-process-collector.service -n 20

로그아웃 후에도 계속 돌리려면 linger가 필요하다. 이미 켜져 있으면 그대로 두면 된다.

  loginctl show-user "\$USER" -p Linger
  sudo loginctl enable-linger "\$USER"
EOF
