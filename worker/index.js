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
Korean explanations must be short, plain Korean (존댓말 아님, 해설체) written ONLY in Hangul, English and digits. NEVER use Chinese characters (漢字/한자/汉字), Japanese kana/kanji or any other script anywhere, even in parentheses. Output strict JSON only, no markdown.`;

// 5형식 생성 규칙과 검증 (AI 가 다른 형식 문장을 섞어 내는 문제 방지)
const FORM_SPEC = {
  1: "S + V only (intransitive verb, no object/complement; optional adverbial phrases). e.g. The baby finally slept. / We arrived just in time.",
  2: "S + V + C (linking verb be/look/sound/feel/seem/get/become + complement describing the subject). e.g. You look exhausted.",
  3: "S + V + O (transitive verb with exactly one direct object, no indirect object, no object complement). e.g. I need a coffee.",
  4: "S + V + IO + DO (give/send/show/tell/buy/lend/make/get + person + thing, NOT using to/for). e.g. Can you send me the link?",
  5: "S + V + O + OC (make/keep/let/have/get/find/call/want/leave/see/hear + object + object complement: adjective, noun, bare infinitive, to-infinitive, -ing or past participle describing the OBJECT). e.g. The news made me so happy. / Please keep the door closed. / I want you to be honest.",
};
const FORM_TAGS = { 1: ["S", "V"], 2: ["S", "V", "C"], 3: ["S", "V", "O"], 4: ["S", "V", "IO", "DO"], 5: ["S", "V", "O", "OC"] };
function partTags(parts) {
  return String(parts || "").split("|").map((x) => (x.match(/\(([^)]*)\)\s*$/) || [])[1] || "").map((t) => t.trim().toUpperCase()).filter((t) => /^(S|V|O|C|IO|DO|OC)$/.test(t));
}
function formOk(it, n) {
  const want = FORM_TAGS[n]; if (!want || !it || !it.en || !it.ko) return false;
  const tags = partTags(it.parts);
  if (tags.join(",") !== want.join(",")) return false;
  // 라벨 붙인 덩어리가 실제 문장 안에 있어야 함 (가짜 라벨 방지)
  const en = it.en.toLowerCase().replace(/[’]/g, "'");
  return String(it.parts).split("|").every((x) => { const w = x.replace(/\([^)]*\)\s*$/, "").replace(/[()]/g, "").trim().toLowerCase().replace(/[’]/g, "'"); return !w || en.includes(w); });
}

const TASKS = {
  dialogue: ({ scenario, level }) => `Create a 12-line spoken dialogue for this situation: "${scenario}".
Speakers alternate A, B, A, B ... (A has 6 lines, B has 6 lines). A is the learner's role (a Korean parent/resident in Auckland) unless the situation says otherwise.
Level: ${level || "intermediate"}. Each line 6-18 words, natural tiki-taka with reactions, small talk, a light NZ touch.
JSON: {"title":"short Korean title","setting":"one-line Korean description","roles":{"A":"Korean role name","B":"Korean role name"},
"lines":[{"sp":"A","en":"...","ko":"natural Korean translation","key":"the most useful phrase copied exactly from en","keyKo":"Korean meaning/usage of the key phrase","tip":"optional short Korean note on culture or nuance, or empty"}]}`,

  naturalize: ({ text }) => `The learner wrote this (Korean or awkward English): "${text}".
Give how a native speaker would naturally SAY it in conversation.
JSON: {"best":"most natural spoken version","casual":"more casual/Kiwi version","polite":"more polite version","ko":"Korean meaning","notes":["short Korean notes on key choices (max 3)"],"key":"most useful phrase from best","keyKo":"its Korean meaning"}`,

  correct: ({ ko, answer, mine, context, target }) => `Korean prompt: "${ko}"
${target ? "The learner is practising: " + target + ". The \"natural\" version MUST keep this same structure/tense (do not rephrase into a different sentence pattern or tense).\n" : ""}${context ? "Dialogue so far:\n" + context + "\n" : ""}${answer ? 'Reference answer: "' + answer + '"\n' : ""}Learner's English: "${mine}"
Judge whether the learner's sentence is correct, natural spoken English that conveys the Korean meaning (other natural wordings are fine).
JSON: {"score":0-100,"ok":true if score>=80,"corrected":"minimal correction of the learner's sentence (same if fine)","natural":"how a native would say it","why":"Korean explanation of the main problems or praise (1-3 sentences)","points":["short Korean grammar/expression points (max 3)"],"types":[up to 3 of exactly these labels for the learner's mistakes, empty array if none: "관사","시제","전치사","어순","어휘 선택","수 일치","구어체 표현","기타"]}`,

  word: ({ word }) => `Explain the English word or phrase "${word}" for a Korean adult learner living in Auckland.
Rules:
- "ko": 1-3 Korean meanings, MOST COMMON sense first, natural everyday Korean (no literal/translation-ese). If the word has clearly different senses, separate with " / " and add a tiny hint in parentheses, e.g. "가정하다(동사) / 가면 (명사)".
- "register": one of "slang", "informal", "neutral", "formal". "region": "NZ", "UK", "US", "AU" or "all" (where it is mainly used; say "NZ/AU" if shared).
- "nuance": 2-3 short Korean sentences: the real feeling/connotation, how Kiwis actually use it, when NOT to use it. For slang/idioms, give the literal vs actual meaning.
- "similar": 2-3 similar words/phrases with a very short Korean difference each.
- Examples: natural spoken lines a native would really say (not textbook), one set in New Zealand daily life. Include the exact word in each.
Example of the quality expected for "chuffed":
{"word":"chuffed","ipaUS":"/tʃʌft/","ipaUK":"/tʃʌft/","pos":"adjective","ko":"뿌듯한, 기쁘고 흡족한","register":"informal","region":"NZ/UK","nuance":"좋은 일이 생겨서 뿌듯하고 기분이 좋을 때 쓰는 구어체예요. 'happy'보다 자랑스러운 기쁨이 담겨 있어요. 격식 있는 글에서는 쓰지 않아요.","similar":[{"w":"stoked","d":"더 들뜨고 신남 (NZ·호주 슬랭)"},{"w":"pleased","d":"무난하고 점잖은 기쁨"}],"examples":[{"en":"I'm so chuffed with how the kitchen turned out.","ko":"부엌이 이렇게 나와서 너무 뿌듯해."}],"collocations":["chuffed to bits","chuffed with"],"drill":[{"ko":"시험에 붙어서 너무 뿌듯해.","en":"I'm so chuffed I passed my test."}]}
JSON only, same fields: {"word":"${word}","ipaUS":"/.../","ipaUK":"/.../","pos":"...","ko":"...","register":"...","region":"...","nuance":"...","similar":[{"w":"...","d":"..."}],"examples":[{"en":"...","ko":"..."}] (3 items),"collocations":["..."] (max 4),"drill":[{"ko":"...","en":"..."}] (2 items)}`,

  writing: ({ topic }) => `Create a 10-line spoken dialogue (A/B alternating, A first, 5 lines each) about: "${topic}", set in everyday Auckland life.
This is for English composition practice: the learner sees the Korean and must say it in English.
JSON: {"title":"short Korean title","lines":[{"sp":"A","ko":"natural Korean","en":"natural spoken English model answer","hint":"key words or pattern hint in English (2-4 words)"}]}`,

  drill: ({ kind, item }) => {
    if (kind === "form") {
      const n = parseInt(String(item).match(/\d/)?.[0] || "0", 10);
      const spec = FORM_SPEC[n] || "";
      return `Make 8 NEW everyday spoken English sentences for Korean learners that are ALL strictly English sentence pattern ${n} (5형식 분류 기준 ${n}형식): ${spec}
Every sentence MUST follow exactly this structure — do NOT write sentences of other patterns (no "go to ... to buy ..." style 1형식 sentences when asked for 5형식, etc.).
NZ daily-life flavour. Label every part in "parts" using exactly the tags of this pattern, written as "words (TAG)" separated by " | ", in sentence order, covering the whole core of the sentence (adverbs/time phrases may be added as "words (부사구)").
Example for 5형식: "The news (S) | made (V) | me (O) | so happy (OC)". Example for 4형식: "She (S) | sent (V) | me (IO) | the link (DO)".
JSON: {"items":[{"en":"...","ko":"natural Korean","note":"Korean: why this is ${n}형식 (one short line)","parts":"..."}]}`;
    }
    return `Make 6 new practice sentences for Korean learners for ${kind === "verb" ? `the basic verb "${item}" (varied core meanings and phrasal uses; every sentence must use "${item}")` : `the English tense/mood "${item}" (natural situations where a native would really use it; every sentence must use exactly this tense/mood)`}.
Spoken, everyday, NZ life flavour.
JSON: {"items":[{"en":"...","ko":"...","note":"Korean: which meaning/structure is used","parts":"","hl":"${kind === "tense" ? "the exact verb phrase copied from en that forms the tense (e.g. \\\"I've lived\\\")" : ""}"}]}`;
  },
};

async function callGemini(env, prompt, task) {
  let lastErr = "";
  const fast = FAST_TASKS.has(task) && task !== "best";
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
            generationConfig: { temperature: 0.7, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: fast ? 1800 : 4000 },
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

// ── Cloudflare Workers AI (같은 계정·키 불필요·빠름) ───────────
const CF_MODELS = ["@cf/google/gemma-3-12b-it", "@cf/meta/llama-3.1-8b-instruct-fast"];
const CF_BEST = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
function parseJsonLoose(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  throw new Error("형식 오류");
}
// 한자·가나가 섞여 나오는 문제 방지 (일부 모델이 한국어 풀이에 漢字를 섞음): 감지되면 다른 모델로 넘기고, 끝내 남으면 제거
const HAN = /[\u2E80-\u2FDF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]/;
const hasHan = (r) => HAN.test(JSON.stringify(r));
function stripHan(v) {
  if (typeof v === "string") return v.replace(new RegExp(HAN.source, "g"), "").replace(/\(\s*\)/g, "").replace(/\s+([,.!?])/g, "$1").replace(/,\s*,/g, ",").replace(/^[,\s]+|[,\s]+$/g, "").replace(/\s{2,}/g, " ");
  if (Array.isArray(v)) return v.map(stripHan);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripHan(x)]));
  return v;
}
const VALID = {
  word: (r) => r && typeof r.ko === "string" && r.ko,
  naturalize: (r) => r && typeof r.best === "string" && r.best,
  correct: (r) => r && typeof r.score === "number",
  drill: (r) => r && Array.isArray(r.items) && r.items.length,
  dialogue: (r) => r && Array.isArray(r.lines) && r.lines.filter((l) => l && l.en).length >= 6,
  writing: (r) => r && Array.isArray(r.lines) && r.lines.filter((l) => l && l.en && l.ko).length >= 5,
};
async function callCF(env, prompt, task, models = CF_MODELS, opt = {}) {
  if (!env.AI) throw new Error("no-ai-binding");
  let lastErr, hanRes;
  for (const model of models) {
    try {
      const out = await Promise.race([
        env.AI.run(model, {
          messages: [{ role: "system", content: SYS }, { role: "user", content: prompt + "\nReturn ONLY the JSON object." }],
          max_tokens: opt.maxTokens || 1600, temperature: 0.5,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), opt.timeout || 10000)),
      ]);
      const text = typeof out === "string" ? out : out?.response ?? out?.choices?.[0]?.message?.content ?? "";
      const res = typeof text === "object" ? text : parseJsonLoose(text);
      if (hasHan(res)) { hanRes = res; lastErr = new Error("한자 혼입"); continue; }   // 다른 모델로 다시 시도
      if (!VALID[task] || VALID[task](res)) return res;
      lastErr = new Error("내용 부족");
    } catch (e) { lastErr = e; }
  }
  if (hanRes && (!VALID[task] || VALID[task](hanRes))) return hanRes;   // 모든 모델이 한자를 섞으면 마지막 결과의 한자를 제거해서 사용
  throw lastErr || new Error("workers-ai 실패");
}

// 빠른 작업은 Workers AI 와 Gemini 를 동시에 호출해 먼저 온 유효한 답을 쓴다
async function callAI(env, prompt, task, engine) {
  const r = await callAI0(env, prompt, task, engine);
  return hasHan(r) ? stripHan(r) : r;   // 모든 경로가 한자를 못 거르면 마지막으로 제거
}
async function callAI0(env, prompt, task, engine) {
  const t0 = Date.now();
  const tag = (via) => (r) => { if (r && typeof r === "object") { r._via = via; r._ms = Date.now() - t0; } return r; };
  if (engine === "best") {   // 정밀 풀이: 큰 모델 우선 (Gemini Flash → Llama 70B), 느려도 되는 두 번째 요청용
    const runs = [];
    if (env.GEMINI_API_KEY) runs.push(callGemini(env, prompt, "best").then((r) => { if (VALID[task] && !VALID[task](r)) throw new Error("내용 부족"); return tag("gemini-best")(r); }));
    if (env.AI) runs.push(callCF(env, prompt, task, CF_BEST).then(tag("llama70b")));
    if (!runs.length) throw new Error("AI 설정 없음");
    try { return await Promise.any(runs); } catch (e) { throw new Error((e.errors || []).map((x) => x.message).join(" / ") || "AI 실패"); }
  }
  if (!FAST_TASKS.has(task)) {
    // 긴 생성(대화·영작 세트): Gemini 가 주 경로. Gemini 가 실패하거나 12초 안에 답이 없으면 Cloudflare(Llama 70B)로 백업을 시작해 먼저 온 유효한 답을 쓴다.
    const long = { maxTokens: 4000, timeout: 40000 };
    const gem = env.GEMINI_API_KEY
      ? callGemini(env, prompt, task).then((r) => { if (VALID[task] && !VALID[task](r)) throw new Error("내용 부족"); return tag("gemini")(r); })
      : Promise.reject(new Error("Gemini 키 없음"));
    if (!env.AI) return await gem;
    const backup = () => callCF(env, prompt, task, CF_BEST, long).then(tag("cloudflare-backup"));
    const hedged = new Promise((resolve, reject) => {
      let started = false, gemErr;
      const start = () => { if (started) return; started = true; backup().then(resolve, (e) => reject(new AggregateError([gemErr, e].filter(Boolean)))); };
      const timer = setTimeout(start, 12000);
      gem.then((r) => { clearTimeout(timer); resolve(r); }, (e) => { gemErr = e; clearTimeout(timer); start(); });
    });
    try { return await hedged; } catch (e) { throw new Error((e.errors || [e]).map((x) => x.message).join(" / ") || "AI 실패"); }
  }
  const runs = [];
  if (env.AI) runs.push(callCF(env, prompt, task).then(tag("workers-ai")));
  if (env.GEMINI_API_KEY) runs.push(callGemini(env, prompt, task).then((r) => { if (VALID[task] && !VALID[task](r)) throw new Error("내용 부족"); return tag("gemini")(r); }));
  if (!runs.length) throw new Error("AI 설정 없음");
  try { return await Promise.any(runs); }
  catch (e) { throw new Error((e.errors || []).map((x) => x.message).join(" / ") || "AI 실패"); }
}

async function bump(env, key, limit) {
  const n = parseInt((await env.STORE.get(key)) || "0", 10);
  if (n >= limit) return false;
  await env.STORE.put(key, String(n + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
}

async function handleAI(request, env) {
  if (request.method !== "POST") return json({ error: "method" }, 405);
  if (!env.GEMINI_API_KEY && !env.AI) return json({ error: "AI 설정이 없습니다 (Cloudflare 비밀 GEMINI_API_KEY 또는 Workers AI 바인딩)" }, 503);
  const code = await readCode(request);
  if (!code) return json({ error: "코드가 필요합니다" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "잘못된 요청" }, 400); }
  const make = TASKS[body.task];
  if (!make) return json({ error: "알 수 없는 작업" }, 400);
  // 입력 길이 제한
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" && v.length > 1500) body[k] = v.slice(0, 1500);

  // 단어 풀이는 모든 사용자가 공유하는 캐시(개인정보 없음). 정밀 풀이(best)가 있으면 그걸 우선, 같은 단어는 즉시 응답하고 AI 한도도 쓰지 않음
  const engine = body.engine === "best" ? "best" : "fast";
  const wbase = body.task === "word" ? String(body.word || "").toLowerCase().trim().slice(0, 60) : "";
  const wkey = wbase ? `wc2:${engine}:${wbase}` : "";
  if (wbase && env.STORE) {
    const hit = (await env.STORE.get(`wc2:best:${wbase}`)) || (engine === "fast" ? await env.STORE.get(`wc2:fast:${wbase}`) : null);
    if (hit) { const r = JSON.parse(hit); if (!hasHan(r)) return json({ result: r, cached: true, best: !!r._best }); }
  }
  const day = nzToday();
  if (env.STORE) {
    const ck = await codeKey(code, env);
    if (!(await bump(env, `ai:${day}:total`, AI_TOTAL_PER_DAY))) return json({ error: "오늘 앱 전체 AI 한도를 다 썼습니다. 내일 다시 시도해 주세요" }, 429);
    if (!(await bump(env, `ai:${day}:${ck}`, AI_PER_CODE_PER_DAY))) return json({ error: `오늘 AI 사용 한도(${AI_PER_CODE_PER_DAY}회)를 다 썼습니다` }, 429);
  }
  try {
    let result = await callAI(env, make(body), body.task, engine);
    if (body.task === "drill" && body.kind === "form") {
      const n = parseInt(String(body.item).match(/\d/)?.[0] || "0", 10);
      let good = (result.items || []).filter((it) => formOk(it, n));
      if (good.length < 3) {   // 형식이 안 맞는 문장이 많으면 한 번 더 (Gemini 우선)
        try { const r2 = await callAI(env, make(body) + "\nIMPORTANT: Previous answer had sentences of the wrong pattern. Every sentence must be exactly " + FORM_TAGS[n].join(" + ") + ".", "drill", "best"); good = good.concat((r2.items || []).filter((it) => formOk(it, n))); } catch {}
      }
      if (!good.length) throw new Error(`${n}형식에 맞는 문장을 만들지 못했어요`);
      result = { ...result, items: good.slice(0, 6) };
    }
    if (body.task === "drill" && body.kind === "tense") result = { ...result, items: (result.items || []).filter((it) => it.en && it.ko && (!it.hl || it.en.toLowerCase().includes(String(it.hl).toLowerCase()))) };
    if (engine === "best" && result) result._best = true;
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
      if (pathname === "/api/health") return json({ ok: true, kv: !!env.STORE, ai: !!env.GEMINI_API_KEY, wai: !!env.AI });
    } catch (e) {
      return json({ error: "서버 오류: " + e.message }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
