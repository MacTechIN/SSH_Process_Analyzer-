# 웹앱 무료 배포

웹앱을 외부에서 접속 가능한 주소로 올리는 절차다. Firebase **Spark 요금제(무료)** 안에서 동작한다.

| 구성 요소 | 서비스 | 비용 |
| --- | --- | --- |
| 웹앱 | Firebase Hosting | 무료. 저장 `10GB`, 전송 `360MB/일` |
| 로그인 | Firebase Auth Google Sign-In | 무료 |
| 데이터 | Cloud Firestore | 무료. 읽기 `50,000/일`, 저장 `1GiB` |
| snapshot 수집 API | 로컬 또는 수집 대상 호스트에서 직접 실행 | 무료 |

Cloud Run은 결제 계정(Blaze)이 있어야 하므로 무료 구성에서는 쓰지 않는다. collector-api를 수집 대상 서버나 사내 장비에서 실행하고 Firestore에만 붙이면 동일하게 동작한다.

## 1. Firebase 프로젝트 만들기

```bash
firebase login                                   # 브라우저 로그인
firebase projects:create ssh-analyzer-staging    # 또는 콘솔에서 생성
```

콘솔에서 두 가지를 켠다.

1. **Authentication → Sign-in method → Google** 사용 설정
2. **Firestore Database** 생성. 위치는 `asia-northeast3`, 모드는 프로덕션

웹 앱 등록은 CLI로도 된다.

```bash
firebase apps:create web "SSH Process Analyzer"
firebase apps:sdkconfig WEB          # apiKey와 appId를 출력한다
```

Google 로그인 사용 설정과 Firestore 데이터베이스 생성은 CLI로 할 수 없고 콘솔에서만 가능하다.

## 2. 프로젝트 별칭 연결

저장소 루트에 `.firebaserc`를 만든다. 이 파일은 `.gitignore` 대상이다. Phase 0 결정에 따라 실제
project ID는 저장소에 커밋하지 않고 배포 환경에서만 둔다. 형식은 `.firebaserc.example`에 있다.

```json
{
  "projects": {
    "default": "ssh-analyzer-staging",
    "production": "ssh-analyzer-production"
  }
}
```

`firebase --config firebase/firebase.json use --add`로 만들어도 된다. 별칭 전환은 `firebase use production`이다.

## 3. Rules와 index 배포

```bash
npm run deploy:rules
```

Rules는 웹 클라이언트의 쓰기를 전부 막고, 읽기는 membership이 있는 tenant의 현재 published generation으로 제한한다. snapshot history는 Firestore 직접 읽기가 금지되어 있다.

## 4. 웹앱 환경 변수

`web/.env`를 만든다. 이 값들은 **공개 설정**이며 비밀이 아니다. 서버 secret과 agent private key는 절대 넣지 않는다.

```text
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=ssh-analyzer-staging.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=ssh-analyzer-staging
VITE_FIREBASE_APP_ID=1:...:web:...
VITE_TENANT_ID=default
VITE_HISTORY_API_BASE_URL=
```

`VITE_HISTORY_API_BASE_URL`은 collector-api를 외부에서 접근 가능한 주소로 띄웠을 때만 채운다. 비워 두면 Snapshot History 화면이 "미설정" 안내를 표시하고 나머지 화면은 정상 동작한다.

## 5. 배포

```bash
npm run deploy:web
```

빌드 → 아티팩트 검사 → Hosting 배포 순서로 실행된다. 검사는 source map, `.env`, private key, service account JSON, 서버 secret 이름이 번들에 들어갔는지 확인하고 하나라도 걸리면 배포를 중단한다.

배포가 끝나면 `https://<projectId>.web.app` 주소가 출력된다. 이 주소가 외부 공개 주소다.

## 6. 조회 권한 부여

로그인만으로는 아무 데이터도 보이지 않는다. membership 문서가 있어야 한다.

1. 사용자가 배포된 주소에서 Google 로그인을 한 번 한다
2. Firebase 콘솔 **Authentication → Users**에서 해당 사용자의 `uid`를 복사한다
3. 권한을 부여한다

```bash
export GOOGLE_CLOUD_PROJECT=ssh-analyzer-staging
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

node collector-api/scripts/grant-membership.mjs \
  --tenant default --uid <firebase uid> --role viewer
```

service account 키는 콘솔의 **프로젝트 설정 → 서비스 계정**에서 만든다. 이 파일은 저장소에 넣지 않는다.

## 7. 데이터 넣기

collector-api를 Firestore에 연결해 실행하고 collector가 그쪽으로 push하게 한다.

```bash
# 수집 서버 또는 사내 장비에서
export STORAGE_DRIVER=firestore
export GOOGLE_CLOUD_PROJECT=ssh-analyzer-staging
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export CURSOR_SIGNING_SECRET=$(openssl rand -base64 32)
npm start

# agent 등록은 docs/agent-key-management.md 참고
node collector-api/scripts/agent-admin.mjs register \
  --tenant default --host web-01 --agent agent_web01 --kid key_01 \
  --public-key <공개키> --actor ops@example.com
```

collector는 `API_BASE_URL`을 이 API 주소로 두고 systemd timer로 `60`초마다 실행한다.

## 무료 할당량 관리

웹앱은 실시간 구독을 쓰지 않는다. 화면을 열거나 새로고침을 누를 때만 Firestore를 읽는다. 실시간 구독을 쓰면 collector가 push할 때마다 모든 process 문서를 다시 읽어 무료 할당량을 금방 소진하기 때문이다.

읽기 비용은 대략 `서버 수 + 현재 process 수`가 조회 1회분이다. process `500`개 기준으로 하루 `50,000` 읽기는 조회 약 `100`회에 해당한다. 설정 화면의 자동 새로고침은 기본값이 꺼져 있고 `1`분, `5`분, `15`분 중에서 고를 수 있다.

## 배포 원칙

- staging과 production은 반드시 별도 프로젝트를 쓴다
- production 배포는 staging P0/E2E 통과 후에만 승격한다
- Hosting 아티팩트에 source map, `.env`, private key, service account JSON, collector 설정을 포함하지 않는다. `npm run verify:web`이 이를 검사한다
