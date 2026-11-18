// English Trainer — Cloudflare Worker
//  - 정적 파일(public/*)은 assets 가 서빙
//  - /api/state : 코드별 학습 이력 (KV, 키는 코드의 SHA-256 해시 — 코드 원문은 저장하지 않음)
//  - /api/ai    : Gemini 호출 (대화 생성·원어민 변환·영작 교정·단어 풀이). 키는 Worker 비밀(GEMINI_API_KEY)
//  - /api/dict  : 무료 영어 사전(dictionaryapi.dev) 프록시 — 미국·영국 발음 음성 링크

// 빠른 작업(단어·변환·교정)은 Flash-Lite 먼저, 긴 생성(대화·영작 세트)은 Flash 먼저. 생각(thinking) 토큰은 꺼서 지연을 줄임
const FAST = ["gemini-flash-lite-latest", "gemini-flash-latest"];
const SLOW = ["gemini-flash-latest", "gemini-flash-lite-latest"];
const FAST_TASKS = new Set(["word", "naturalize", "correct", "drill"]);
const AI_PER_CODE_PER_DAY = 80;   // 코드 하나가 하루에 쓸 수 있는 AI 호출
const AI_TOTAL_PER_DAY = 400;     // 앱 전체 하루 상한 (무료 등급 보호)
const MAX_STATE_BYTES = 900_000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const CODE_RE = /^[A-Za-z0-9가-힣_-]{4,24}$/;

async function codeKey(code, env) {
  const salt = env.CODE_SALT || "english-trainer";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + code.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

function nzToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date());
}

async function readCode(request) {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || request.headers.get("x-code") || "").trim();
  if (!CODE_RE.test(code)) return null;
  return code;
}

// ── 학습 이력 ──────────────────────────────────────────────
async function handleState(request, env) {
  if (!env.STORE) return json({ error: "KV(STORE)가 연결되지 않았습니다" }, 500);
  const code = await readCode(request);
  if (!code) return json({ error: "코드는 4~24자(영문·숫자·한글·-_)" }, 400);
  const key = "u:" + (await codeKey(code, env));

  if (request.method === "GET") {
    const raw = await env.STORE.get(key);
    return json({ state: raw ? JSON.parse(raw) : null });
  }
  if (request.method === "PUT") {
    const body = await request.text();
    if (body.length > MAX_STATE_BYTES) return json({ error: "저장 용량 초과 — 오래된 기록을 정리해 주세요" }, 413);
    let incoming;
    try { incoming = JSON.parse(body); } catch { return json({ error: "잘못된 데이터" }, 400); }
    if (!incoming || typeof incoming !== "object") return json({ error: "잘못된 데이터" }, 400);
    // 다른 기기에서 더 최근에 저장했으면 덮어쓰지 않고 서버본을 돌려준다
    const raw = await env.STORE.get(key);
    const cur = raw ? JSON.parse(raw) : null;
    if (cur && (cur.rev || 0) > (incoming.baseRev ?? incoming.rev ?? 0)) return json({ conflict: true, state: cur }, 409);
    incoming.rev = (cur?.rev || 0) + 1;
    delete incoming.baseRev;
    incoming.updatedAt = new Date().toISOString();
    await env.STORE.put(key, JSON.stringify(incoming));
    return json({ ok: true, rev: incoming.rev, updatedAt: incoming.updatedAt });
  }
  return json({ error: "method" }, 405);
}

// ── AI ─────────────────────────────────────────────────────
const SYS = `You are a friendly English speaking coach for a Korean adult living in Auckland, New Zealand.
Write natural, spoken, everyday English that any native speaker (NZ, US, UK, AU) understands instantly.
Reflect Kiwi everyday life and culture (e.g. "heaps", "keen", "sweet as", "no worries", "togs", "jandals", "dairy", "tea" for dinner, "bach", "kia ora", school pick-up, rugby, BBQs, weather small talk) but keep slang light and always explain it in Korean.
Korean explanations must be short, plain Korean (존댓말 아님, 해설체). Output strict JSON only, no markdown.`;

const TASKS = {
  dialogue: ({ scenario, level }) => `Create a 12-line spoken dialogue for this situation: "${scenario}".
Speakers alternate A, B, A, B ... (A has 6 lines, B has 6 lines). A is the learner's role (a Korean parent/resident in Auckland) unless the situation says otherwise.
Level: ${level || "intermediate"}. Each line 6-18 words, natural tiki-taka with reactions, small talk, a light NZ touch.
JSON: {"title":"short Korean title","setting":"one-line Korean description","roles":{"A":"Korean role name","B":"Korean role name"},
"lines":[{"sp":"A","en":"...","ko":"natural Korean translation","key":"the most useful phrase copied exactly from en","keyKo":"Korean meaning/usage of the key phrase","tip":"optional short Korean note on culture or nuance, or empty"}]}`,

  naturalize: ({ text }) => `The learner wrote this (Korean or awkward English): "${text}".
Give how a native speaker would naturally SAY it in conversation.
JSON: {"best":"most natural spoken version","casual":"more casual/Kiwi version","polite":"more polite version","ko":"Korean meaning","notes":["short Korean notes on key choices (max 3)"],"key":"most useful phrase from best","keyKo":"its Korean meaning"}`,

  correct: ({ ko, answer, mine, context }) => `Korean prompt: "${ko}"
${context ? "Dialogue so far:\n" + context + "\n" : ""}${answer ? 'Reference answer: "' + answer + '"\n' : ""}Learner's English: "${mine}"
Judge whether the learner's sentence is correct, natural spoken English that conveys the Korean meaning (other natural wordings are fine).
JSON: {"score":0-100,"ok":true if score>=80,"corrected":"minimal correction of the learner's sentence (same if fine)","natural":"how a native would say it","why":"Korean explanation of the main problems or praise (1-3 sentences)","points":["short Korean grammar/expression points (max 3)"]}`,

  word: ({ word }) => `Explain the English word or phrase "${word}" for a Korean learner.
JSON: {"word":"${word}","ipaUS":"/.../","ipaUK":"/.../","pos":"part of speech","ko":"Korean meanings (short, comma separated)","nuance":"Korean note on nuance/usage, mention NZ/UK/US differences if any",
"examples":[{"en":"natural spoken example","ko":"Korean"}] (3 short examples, everyday conversation, one with a NZ setting),
"collocations":["common collocations (max 4)"],"drill":[{"ko":"Korean sentence that should be said in English using the word","en":"model answer"}] (2 items)}`,

  writing: ({ topic }) => `Create a 10-line spoken dialogue (A/B alternating, A first, 5 lines each) about: "${topic}", set in everyday Auckland life.
This is for English composition practice: the learner sees the Korean and must say it in English.
JSON: {"title":"short Korean title","lines":[{"sp":"A","ko":"natural Korean","en":"natural spoken English model answer","hint":"key words or pattern hint in English (2-4 words)"}]}`,

  drill: ({ kind, item }) => `Make 6 new practice sentences for Korean learners for ${kind === "verb" ? `the basic verb "${item}" (varied core meanings and phrasal uses)` : `English sentence pattern ${item} (5형식 분류 기준)`}.
Spoken, everyday, NZ life flavour.
JSON: {"items":[{"en":"...","ko":"...","note":"Korean: which meaning/structure is used","parts":"for sentence patterns: label parts like S | V | O | C, else empty"}]}`,
};

async function callGemini(env, prompt, task) {
  let lastErr = "";
  const fast = FAST_TASKS.has(task);
  for (const model of fast ? FAST : SLOW) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          signal: AbortSignal.timeout(fast ? 12000 : 30000),
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYS }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: fast ? 1500 : 4000 },
          }),
        });
      } catch { lastErr = "시간 초과"; break; }   // 느린 모델은 기다리지 않고 바로 다음 모델로
      if (r.ok) {
        const d = await r.json();
        const text = d?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        try { return JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); }
        catch { lastErr = "AI 응답 형식 오류"; continue; }
      }
      lastErr = `Gemini ${r.status}`;
      if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 500)); continue; }
      break;
    }
  }
  throw new Error(lastErr || "AI 실패");
}

async function bump(env, key, limit) {
  const n = parseInt((await env.STORE.get(key)) || "0", 10);
  if (n >= limit) return false;
  await env.STORE.put(key, String(n + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
}

async function handleAI(request, env) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  if (!env.GEMINI_API_KEY) return json({ error: "AI 키가 설정되지 않았습니다 (Cloudflare 비밀 GEMINI_API_KEY)" }, 503);
  const code = await readCode(request);
  if (!code) return json({ error: "코드가 필요합니다" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "잘못된 요청" }, 400); }
  const make = TASKS[body.task];
  if (!make) return json({ error: "알 수 없는 작업" }, 400);
  // 입력 길이 제한
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" && v.length > 1500) body[k] = v.slice(0, 1500);

  // 단어 풀이는 모든 사용자가 공유하는 캐시(개인정보 없음) — 같은 단어는 즉시 응답, AI 한도도 쓰지 않음
  const wkey = body.task === "word" ? "wc:" + String(body.word || "").toLowerCase().trim().slice(0, 60) : "";
  if (wkey && env.STORE) {
    const hit = await env.STORE.get(wkey);
    if (hit) return json({ result: JSON.parse(hit), cached: true });
  }
  const day = nzToday();
  if (env.STORE) {
    const ck = await codeKey(code, env);
    if (!(await bump(env, `ai:${day}:total`, AI_TOTAL_PER_DAY))) return json({ error: "오늘 앱 전체 AI 한도를 다 썼습니다. 내일 다시 시도해 주세요" }, 429);
    if (!(await bump(env, `ai:${day}:${ck}`, AI_PER_CODE_PER_DAY))) return json({ error: `오늘 AI 사용 한도(${AI_PER_CODE_PER_DAY}회)를 다 썼습니다` }, 429);
  }
  try {
    const result = await callGemini(env, make(body), body.task);
    if (wkey && env.STORE && result && result.ko) await env.STORE.put(wkey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 90 });
    return json({ result });
  } catch (e) {
    return json({ error: `AI가 잠시 바쁩니다 (${e.message}). 잠시 후 다시 시도해 주세요` }, 502);
  }
}

// ── 사전 ───────────────────────────────────────────────────
async function handleDict(request) {
  const w = (new URL(request.url).searchParams.get("w") || "").trim().toLowerCase();
  if (!/^[a-z' -]{1,40}$/.test(w)) return json({ error: "word" }, 400);
  const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, {
    headers: { "user-agent": "english-trainer (personal study app)" },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!r.ok) return json({ entries: [] });
  const d = await r.json();
  const audio = { us: "", uk: "", au: "" };
  const phon = { us: "", uk: "" };
  for (const e of d) for (const p of e.phonetics || []) {
    const a = p.audio || "";
    for (const reg of ["us", "uk", "au"]) if (a.includes(`-${reg}.mp3`) && !audio[reg]) { audio[reg] = a; if (p.text && phon[reg] === "") phon[reg] = p.text; }
  }
  const defs = [];
  for (const e of d) for (const m of e.meanings || []) for (const df of (m.definitions || []).slice(0, 2)) defs.push({ pos: m.partOfSpeech, def: df.definition, ex: df.example || "" });
  return json({ word: w, audio, phon, defs: defs.slice(0, 6) });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/state") return await handleState(request, env);
      if (pathname === "/api/ai") return await handleAI(request, env);
      if (pathname === "/api/dict") return await handleDict(request);
      if (pathname === "/api/health") return json({ ok: true, kv: !!env.STORE, ai: !!env.GEMINI_API_KEY });
    } catch (e) {
      return json({ error: "서버 오류: " + e.message }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
