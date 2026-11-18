# English_Trainer 작업 규칙

## 브랜치
- 모든 작업은 `main`에서 직접 하고 커밋도 `main`에 합니다.
- `main`에 push하면 Cloudflare에 자동 배포되므로, push 전에 사용자에게 확인합니다.

## 로컬 실행
- `npx --yes wrangler@4 dev --port 8790` → http://127.0.0.1:8790

## 데이터
- 학습 이력은 KV `STORE`에 `u:<코드 해시>` 키로 저장. 코드 원문·개인 정보는 저장소에 커밋하지 않음.
- Gemini 키는 Cloudflare Secret `GEMINI_API_KEY`에만 둠.
- 필수 콘텐츠(`public/data/*.js`)를 고칠 때 `key`는 `en` 문장 안에 그대로 들어 있어야 형광펜이 표시됨.
