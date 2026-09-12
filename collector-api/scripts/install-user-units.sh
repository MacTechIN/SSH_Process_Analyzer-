#!/usr/bin/env bash
# sudo 없이 사용자 systemd 유닛으로 collector-api를 상시 실행한다.
# Cloud Run 대신 자체 장비에서 돌릴 때 쓴다.
#
#   GOOGLE_CLOUD_PROJECT=ssh-analyzer \
#   GOOGLE_APPLICATION_CREDENTIALS=$HOME/.secrets/ssh-analyzer-admin.json \
#   BIND_HOST=100.101.238.106 \
#   ./collector-api/scripts/install-user-units.sh
#
# BIND_HOST를 사설망 주소로 두면 LAN과 공인 인터페이스에는 열리지 않는다.
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT를 지정하세요}"
CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:?GOOGLE_APPLICATION_CREDENTIALS 경로를 지정하세요}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
BIND_PORT="${BIND_PORT:-8090}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

CONFIG_DIR="$HOME/.config/ssh-process-collector"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_FILE="$CONFIG_DIR/api.env"

if [ -z "$NODE_BIN" ]; then
  echo "node를 찾을 수 없습니다. Node 20 이상을 설치하고 NODE_BIN을 지정하세요." >&2
  exit 1
fi
if [ ! -r "$CREDENTIALS" ]; then
  echo "service account 키를 읽을 수 없습니다: $CREDENTIALS" >&2
  exit 1
fi

umask 077
mkdir -p "$CONFIG_DIR" "$UNIT_DIR"

# 이미 있는 secret은 유지한다. 새로 만들면 페이지네이션 cursor가 전부 무효가 된다.
if [ -f "$ENV_FILE" ] && grep -q '^CURSOR_SIGNING_SECRET=.' "$ENV_FILE"; then
  CURSOR_SECRET="$(grep '^CURSOR_SIGNING_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
else
  CURSOR_SECRET="$(openssl rand -base64 32)"
fi

cat > "$ENV_FILE" <<EOF
STORAGE_DRIVER=firestore
GOOGLE_CLOUD_PROJECT=$PROJECT_ID
GOOGLE_APPLICATION_CREDENTIALS=$CREDENTIALS
CURSOR_SIGNING_SECRET=$CURSOR_SECRET
CURSOR_SIGNING_KEY_ID=v1
HOST=$BIND_HOST
PORT=$BIND_PORT
DEV_READ_API_ENABLED=false
EOF
chmod 600 "$ENV_FILE"

cat > "$UNIT_DIR/ssh-process-collector-api.service" <<EOF
[Unit]
Description=SSH Process Analyzer collector API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN collector-api/src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
EOF

cat > "$UNIT_DIR/ssh-process-collector-cleanup.service" <<EOF
[Unit]
Description=SSH Process Analyzer cleanup job

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN collector-api/scripts/cleanup.mjs
TimeoutStartSec=900
NoNewPrivileges=yes
PrivateTmp=yes
EOF

cat > "$UNIT_DIR/ssh-process-collector-cleanup.timer" <<EOF
[Unit]
Description=Run the SSH Process Analyzer cleanup job hourly

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
AccuracySec=5min
Persistent=true
Unit=ssh-process-collector-cleanup.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now ssh-process-collector-api.service
systemctl --user enable --now ssh-process-collector-cleanup.timer

sleep 3
STATUS="$(systemctl --user is-active ssh-process-collector-api.service || true)"

cat <<EOF

collector-api: $STATUS
수신 주소    : http://$BIND_HOST:$BIND_PORT
cleanup      : 1시간 주기 타이머 등록

확인:
  curl -s -o /dev/null -w '%{http_code}\\n' http://$BIND_HOST:$BIND_PORT/healthz
  journalctl --user -u ssh-process-collector-api.service -n 20

로그아웃 후에도 유지하려면 linger가 필요하다.
  loginctl show-user "\$USER" -p Linger
  sudo loginctl enable-linger "\$USER"
EOF
