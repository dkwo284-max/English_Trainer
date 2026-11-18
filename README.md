# English Trainer

NZ 생활 구어체 스피킹·영작 훈련 대시보드. 코드(예: `0109`)를 입력하면 어느 기기에서든 그 코드의 학습 이력이 이어집니다.

## 기능
- **오늘의 스피킹**: 12문장 대화(A·B 각 6문장), 핵심 표현 형광펜, 미국·영국 발음 듣기, 따라 말하기(음성 인식 점수), 가리고 말하기, 역할 연습, 문장·시나리오 저장
- **내 시나리오**: 상황을 직접 입력하면 AI가 12문장 대화를 만들어 보관
- **영작 10문장**: 대화 흐름이 이어지는 영작, AI 코치 교정. 틀린 문장은 복습함에 자동 저장
- **기본동사(12개)·5형식**: 예문, 문장 성분 표시, 영작 퀴즈, AI 새 문장
- **복습**: 틀린 문장을 1·3·7·14·30·60일 간격으로 반복 복습
- **도구**: 단어 검색(뜻·IPA·미국/영국 원어민 음성·예문·말하기 연습), 한국어 → 원어민 말투 변환

## 구조
- `public/`: 화면(정적 파일). 필수 콘텐츠는 `public/data/*.js`
- `worker/index.js`: Cloudflare Worker API
  - `/api/state`: 코드별 학습 이력을 KV(`STORE`)에 저장. 키는 코드의 SHA-256 해시라 코드 원문은 저장하지 않음
  - `/api/ai`: Gemini 호출. 코드당 하루 80회, 앱 전체 하루 400회 제한
  - `/api/dict`: 무료 사전(dictionaryapi.dev) 원어민 발음 음성

## 처음 설정 (Cloudflare, 1회)
1. Cloudflare 대시보드 → Workers & Pages → Create → GitHub 저장소 `English_Trainer` 연결(Workers Builds)
2. KV: `wrangler.jsonc`의 `kv_namespaces`에 id가 없으면 첫 배포 때 자동으로 생성됩니다. 실패하면 Storage & Databases → KV에서 `english-trainer`를 만들고 그 ID를 `"id"`로 넣어 주세요.
3. Worker → Settings → Variables and Secrets에 **Secret** `GEMINI_API_KEY`(이 앱 전용 Gemini 키)를 추가합니다. 선택 사항으로 `CODE_SALT`(아무 긴 문자열)를 넣을 수 있는데, 나중에 바꾸면 기존 이력과 연결이 끊어지므로 처음에만 정하세요.
4. `main`에 push하면 자동 배포됩니다.

## 로컬 실행
`npx --yes wrangler@4 dev --port 8790` → http://127.0.0.1:8790 (로컬 KV 사용, AI는 `.dev.vars`에 `GEMINI_API_KEY=...`를 넣을 때만 동작. `.dev.vars`는 커밋 금지)

## 주의
- 코드가 짧으면 남이 짐작할 수 있습니다. 4자리보다 긴 코드를 권장합니다.
- AI가 없거나 바쁠 때도 필수 콘텐츠·듣기·저장·복습은 동작합니다. 영작은 단어 일치율로 판단하고 직접 '맞은 걸로'를 고를 수 있습니다.
