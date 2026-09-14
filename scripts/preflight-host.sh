#!/usr/bin/env bash
# 이관 대상 서버에서 먼저 실행해 필요한 조건이 갖춰졌는지 확인한다.
# 아무것도 설치하거나 변경하지 않는다.
#
#   ./scripts/preflight-host.sh
#   BIND_PORT=8090 CREDENTIALS=$HOME/.secrets/ssh-analyzer-admin.json ./scripts/preflight-host.sh

BIND_PORT="${BIND_PORT:-8090}"
CREDENTIALS="${CREDENTIALS:-$HOME/.secrets/ssh-analyzer-admin.json}"
REQUIRED_NODE_MAJOR=20

fail=0
warn=0

ok()   { printf '  \033[32mOK\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
note() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; warn=$((warn + 1)); }

echo "SSH Process Analyzer 사전 점검 — $(hostname)"
echo

echo "실행 환경"
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge "$REQUIRED_NODE_MAJOR" ]; then
    ok "node $(node --version)"
  else
    bad "node $(node --version) — $REQUIRED_NODE_MAJOR 이상이 필요하다"
  fi
else
  bad "node 없음 — Node $REQUIRED_NODE_MAJOR 이상을 설치한다"
fi

for tool in git openssl curl; do
  command -v "$tool" >/dev/null 2>&1 && ok "$tool" || bad "$tool 없음"
done

command -v basenc >/dev/null 2>&1 && ok "basenc (공개키 인코딩)" \
  || bad "basenc 없음 — coreutils를 설치한다"

echo
echo "systemd 사용자 세션"
if systemctl --user is-system-running >/dev/null 2>&1 || [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  ok "systemctl --user 사용 가능"
  linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo unknown)"
  if [ "$linger" = "yes" ]; then
    ok "linger 활성 — 로그아웃 후에도 서비스가 유지된다"
  else
    note "linger 비활성 — 'sudo loginctl enable-linger $USER' 필요 (sudo가 필요한 유일한 항목)"
  fi
else
  bad "systemctl --user 를 쓸 수 없다"
fi

for unit in ssh-process-collector-api.service ssh-process-collector.timer; do
  if systemctl --user list-unit-files "$unit" 2>/dev/null | grep -q "$unit"; then
    note "$unit 이(가) 이미 있다 — 재설치는 덮어쓴다"
  fi
done

echo
echo "네트워크"
if command -v tailscale >/dev/null 2>&1; then
  ts_ip="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "$ts_ip" ] && ok "tailscale 주소 $ts_ip — BIND_HOST 로 사용한다" \
    || note "tailscale 주소를 확인할 수 없다"
else
  note "tailscale 없음 — BIND_HOST 를 직접 정해야 한다"
fi

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$BIND_PORT "; then
  bad "포트 $BIND_PORT 사용 중 — BIND_PORT 를 바꾸거나 기존 프로세스를 정리한다"
else
  ok "포트 $BIND_PORT 사용 가능"
fi

echo
echo "자격 증명과 수집 대상"
if [ -r "$CREDENTIALS" ]; then
  perm="$(stat -c '%a' "$CREDENTIALS" 2>/dev/null)"
  [ "$perm" = "600" ] && ok "service account 키 $CREDENTIALS (권한 600)" \
    || note "service account 키 권한이 $perm — 'chmod 600 $CREDENTIALS' 권장"
else
  note "service account 키 없음 — 콘솔에서 발급해 $CREDENTIALS 에 둔다"
fi

if [ -r /proc/stat ]; then
  procs="$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
  ok "수집 예상 프로세스 약 ${procs}개"
  daily=$((procs * 12))
  echo "        2시간 주기 기준 하루 쓰기 약 ${daily}회 (이 서버 몫)"
  [ "$daily" -gt 20000 ] && note "이 서버만으로 Firestore 무료 한도 20,000회를 넘는다 — 주기를 늘린다"
else
  bad "/proc 를 읽을 수 없다"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "결과: 실패 ${fail}건, 경고 ${warn}건 — 실패 항목을 먼저 해결한다"
  exit 1
fi
echo "결과: 통과 (경고 ${warn}건) — docs/migrate-to-maindev.md 1단계부터 진행한다"
