# Collector

Linux process 수집기와 systemd oneshot unit을 구현할 위치다.

MVP collector는 OS process 소유주 이름과 작업 분류용 allowlist 필드만 수집한다. raw command 전체와 환경 변수는 전송하지 않는다.
