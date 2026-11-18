/* English Trainer — 코드별 학습 이력(Cloudflare KV) + Gemini 보조 */
(() => {
"use strict";

// ── 유틸 ────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date());
const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dayNum = (d) => Math.floor(new Date(d + "T12:00:00Z").getTime() / 86400000);
const norm = (s) => String(s || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };
const SRS = [1, 3, 7, 14, 30, 60];

function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ── 상태 & 동기화 ───────────────────────────────────────
let CODE = "";
let S = null;
const blank = () => ({ v: 1, rev: 0, created: today(), saved: [], scenarios: [], wrong: [], words: [], history: {}, done: {}, settings: { accent: "en-US", rate: 0.95, showKo: true } });

function fix(s) {
  const b = blank();
  s = Object.assign(b, s || {});
  s.settings = Object.assign(blank().settings, s.settings || {});
  for (const k of ["saved", "scenarios", "wrong", "words"]) if (!Array.isArray(s[k])) s[k] = [];
  return s;
}

function setDot(cls, title) { const d = $("#syncDot"); d.className = "dot " + (cls || ""); d.title = title || ""; }

async function api(path, opt = {}) {
  const r = await fetch(path, { ...opt, headers: { "content-type": "application/json", "x-code": CODE, ...(opt.headers || {}) } });
  let data = {};
  try { data = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, data };
}

function mergeStates(a, b) {
  // 두 기기에서 동시에 바꾼 경우: 목록은 id 기준 합치고(최근 것 우선), 날짜별 기록은 큰 값
  const out = fix(JSON.parse(JSON.stringify(b)));
  for (const k of ["saved", "scenarios", "wrong", "words"]) {
    const m = new Map();
    for (const x of [...(b[k] || []), ...(a[k] || [])]) {
      const id = x.id || x.w;
      const cur = m.get(id);
      if (!cur || (x.upd || x.at || "") > (cur.upd || cur.at || "")) m.set(id, x);
    }
    out[k] = [...m.values()].filter((x) => !x.del);
  }
  for (const [d, h] of Object.entries(a.history || {})) {
    out.history[d] = out.history[d] || {};
    for (const [k, v] of Object.entries(h)) out.history[d][k] = Math.max(out.history[d][k] || 0, v);
  }
  for (const [k, v] of Object.entries(a.done || {})) out.done[k] = out.done[k] || v;
  out.settings = Object.assign({}, b.settings, a.settings);
  return out;
}

let saveTimer = null, saving = false, dirty = false, online = true;
function save() {
  lsSet("et:s:" + CODE, JSON.stringify(S));
  lsSet("et:dirty:" + CODE, "1");
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(push, 1200);
  setDot("busy", "저장 중");
}
async function push() {
  if (saving) { saveTimer = setTimeout(push, 800); return; }
  if (!dirty) return;
  saving = true; dirty = false;
  try {
    const body = JSON.stringify({ ...S, baseRev: S.rev });
    let r = await api("/api/state", { method: "PUT", body });
    if (r.status === 409 && r.data.state) {
      S = mergeStates(S, r.data.state);
      S.rev = r.data.state.rev;
      r = await api("/api/state", { method: "PUT", body: JSON.stringify({ ...S, baseRev: S.rev }) });
      render();
    }
    if (r.ok) { S.rev = r.data.rev; lsSet("et:s:" + CODE, JSON.stringify(S)); if (!dirty) lsDel("et:dirty:" + CODE); setDot("ok", "동기화됨 " + new Date().toLocaleTimeString()); online = true; }
    else { dirty = true; setDot("err", r.data.error || "저장 실패 — 이 기기에만 보관 중"); online = false; }
  } catch {
    dirty = true; online = false; setDot("err", "오프라인 — 이 기기에만 보관 중, 연결되면 자동 저장");
  } finally { saving = false; }
}
window.addEventListener("online", () => { if (dirty) push(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && dirty) push(); });

async function login(code) {
  CODE = code.trim();
  lsSet("et:code", CODE);
  const local = lsGet("et:s:" + CODE);
  S = fix(local ? JSON.parse(local) : null);
  setDot("busy", "불러오는 중");
  try {
    const r = await api("/api/state");
    if (r.ok) {
      const remote = r.data.state;
      const unsynced = !!lsGet("et:dirty:" + CODE);
      if (remote && !unsynced) S = fix(remote);                       // 이 기기에 안 올린 변경이 없으면 서버본 그대로 (다른 기기에서 지운 것도 반영)
      else if (remote) { S = mergeStates(S, remote); S.rev = remote.rev; save(); }  // 이 기기 변경 + 서버본 합쳐서 다시 올림
      else save();                                                      // 서버에 아직 없음 → 처음 올림
      setDot("ok", "동기화됨");
    } else setDot("err", r.data.error || "서버 연결 실패 — 이 기기에만 저장");
  } catch { setDot("err", "오프라인 — 이 기기에만 저장"); online = false; }
  lsSet("et:s:" + CODE, JSON.stringify(S));
  $("#login").hidden = true; $("#app").hidden = false;
  $("#codeLabel").textContent = CODE;
  go(location.hash.slice(1) || "home");
}

// ── 기록 ────────────────────────────────────────────────
function log(kind, n = 1) {
  const d = today();
  S.history[d] = S.history[d] || {};
  S.history[d][kind] = (S.history[d][kind] || 0) + n;
  save();
}
const todayH = () => S.history[today()] || {};
function streak() {
  let n = 0, d = today();
  const any = (x) => Object.values(S.history[x] || {}).some((v) => v > 0);
  if (!any(d)) d = addDays(d, -1);
  while (any(d)) { n++; d = addDays(d, -1); }
  return n;
}
const dueItems = () => S.wrong.filter((w) => !w.del && w.due <= today());

function addWrong(it, mine, res) {
  const key = norm(it.en);
  let w = S.wrong.find((x) => norm(x.en) === key);
  const now = new Date().toISOString();
  if (!w) { w = { id: uid(), ko: it.ko, en: it.en, src: it.src || "", reps: 0, at: now }; S.wrong.unshift(w); }
  Object.assign(w, { mine, why: res?.why || "", natural: res?.natural || "", box: 0, due: addDays(today(), 1), upd: now });
  save();
}
function reviewResult(w, ok) {
  w.reps = (w.reps || 0) + 1;
  w.box = ok ? Math.min((w.box || 0) + 1, SRS.length) : 0;
  w.upd = new Date().toISOString();
  if (ok && w.box >= SRS.length) { w.mastered = true; w.due = "9999-12-31"; }
  else w.due = addDays(today(), ok ? SRS[w.box - 1] || 1 : 1);
  save();
}
function saveSentence(x) {
  const key = norm(x.en);
  if (S.saved.some((s) => norm(s.en) === key)) { toast("이미 저장된 문장이에요"); return false; }
  S.saved.unshift({ id: uid(), en: x.en, ko: x.ko || "", key: x.key || "", keyKo: x.keyKo || "", src: x.src || "", at: new Date().toISOString() });
  save(); toast("저장했어요 ☆"); return true;
}
const isSaved = (en) => S.saved.some((s) => norm(s.en) === norm(en));

// ── 음성: 듣기(TTS)·따라 말하기(STT) ────────────────────
let voices = [];
const loadVoices = () => { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; };
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function pickVoice(lang) {
  const pref = voices.filter((v) => v.lang.replace("_", "-").toLowerCase() === lang.toLowerCase());
  return pref.find((v) => /natural|neural|google|samantha|daniel|serena|karen/i.test(v.name)) || pref[0]
    || voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
}
function speak(text, lang, rate) {
  if (!window.speechSynthesis) { toast("이 브라우저는 음성 재생을 지원하지 않아요"); return Promise.resolve(); }
  speechSynthesis.cancel();
  return new Promise((res) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || S.settings.accent; u.rate = rate || S.settings.rate;
    const v = pickVoice(u.lang); if (v) u.voice = v;
    u.onend = u.onerror = () => res();
    speechSynthesis.speak(u);
  });
}
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function listen(lang = "en-NZ") {
  return new Promise((res, rej) => {
    if (!SR) return rej(new Error("이 브라우저는 음성 인식을 지원하지 않아요 (Chrome·Safari 권장)"));
    const r = new SR(); r.lang = lang; r.interimResults = false; r.maxAlternatives = 3;
    r.onresult = (e) => res([...e.results[0]].map((a) => a.transcript));
    r.onerror = (e) => rej(new Error(e.error === "not-allowed" ? "마이크 권한을 허용해 주세요" : "다시 말해 주세요"));
    r.onend = () => res([]);
    r.start();
  });
}
function similarity(a, b) {
  const x = norm(a).split(" "), y = norm(b).split(" ");
  if (!x[0] || !y[0]) return 0;
  const m = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++)
    m[i][j] = x[i - 1] === y[j - 1] ? m[i - 1][j - 1] + 1 : Math.max(m[i - 1][j], m[i][j - 1]);
  return Math.round((m[x.length][y.length] / Math.max(x.length, y.length)) * 100);
}

// ── AI ──────────────────────────────────────────────────
async function ai(task, payload) {
  const r = await api("/api/ai", { method: "POST", body: JSON.stringify({ task, ...payload }) });
  if (!r.ok) throw new Error(r.data.error || "AI를 쓸 수 없어요");
  return r.data.result;
}

// ── 공통 렌더 조각 ──────────────────────────────────────
const WORD_RE = /[A-Za-zĀ-ūā-ū][A-Za-zĀ-ūā-ū'’-]*/g;
function wrapWords(raw) {
  let out = "", last = 0;
  for (const m of raw.matchAll(WORD_RE)) {
    out += esc(raw.slice(last, m.index)) + `<span class="w" data-w="${esc(m[0])}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(raw.slice(last));
}
function tappable(en, key) {
  // 단어마다 눌러서 사전 열기 + 핵심 표현 형광펜
  en = String(en || "");
  const i = key ? en.toLowerCase().indexOf(String(key).toLowerCase()) : -1;
  if (i < 0) return wrapWords(en);
  return wrapWords(en.slice(0, i)) + '<mark class="key">' + wrapWords(en.slice(i, i + key.length)) + "</mark>" + wrapWords(en.slice(i + key.length));
}
const sayBtns = (en) => `<button class="act" data-say="${esc(en)}" data-lang="en-US">🔊 US</button><button class="act" data-say="${esc(en)}" data-lang="en-GB">🔊 UK</button><button class="act" data-say="${esc(en)}" data-slow="1">🐢</button>`;
const starBtn = (o) => `<button class="act ${isSaved(o.en) ? "on" : ""}" data-star='${esc(JSON.stringify(o))}'>${isSaved(o.en) ? "★" : "☆"} 저장</button>`;

// 전역 클릭: 듣기·저장·단어
document.addEventListener("click", (e) => {
  const say = e.target.closest("[data-say]");
  if (say) { speak(say.dataset.say, say.dataset.lang, say.dataset.slow ? 0.7 : undefined); return; }
  const st = e.target.closest("[data-star]");
  if (st) { const o = JSON.parse(st.dataset.star); if (saveSentence(o)) { st.classList.add("on"); st.textContent = "★ 저장"; } return; }
  const w = e.target.closest(".w[data-w]");
  if (w && !e.target.closest(".hidden-en")) { openWord(w.dataset.w.replace(/[’']s$/i, "")); return; }
  if (e.target.closest("[data-close]")) closeSheet();
});

// ── 시트(단어·변환) ─────────────────────────────────────
function openSheet(html) { $("#sheetBody").innerHTML = html; $("#sheet").hidden = false; document.body.style.overflow = "hidden"; }
function closeSheet() { $("#sheet").hidden = true; document.body.style.overflow = ""; window.speechSynthesis?.cancel(); }

function openTools(tab = "word", prefill = "") {
  openSheet(`<h2 style="margin-bottom:6px">도구</h2>
    <div class="seg" id="toolSeg"><button data-t="word">단어 검색</button><button data-t="conv">원어민처럼 바꾸기</button></div>
    <div id="toolBody"></div>`);
  const show = (t) => {
    [...$("#toolSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    if (t === "word") {
      $("#toolBody").innerHTML = `<form id="wForm" class="row"><input class="text" id="wIn" placeholder="모르는 단어·표현 (예: stoked)" value="${esc(prefill)}"><button class="btn primary">검색</button></form><div id="wOut"></div>
        ${S.words.length ? `<div class="label" style="margin-top:14px">최근 찾은 단어</div><div class="chips">${S.words.slice(0, 15).map((w) => `<button class="chip" data-rw="${esc(w.w)}">${esc(w.w)}</button>`).join("")}</div>` : ""}`;
      $("#wForm").onsubmit = (e) => { e.preventDefault(); const v = $("#wIn").value.trim(); if (v) wordLookup(v, $("#wOut")); };
      $("#toolBody").querySelectorAll("[data-rw]").forEach((b) => (b.onclick = () => { $("#wIn").value = b.dataset.rw; wordLookup(b.dataset.rw, $("#wOut")); }));
      if (prefill) wordLookup(prefill, $("#wOut"));
    } else {
      $("#toolBody").innerHTML = `<p class="small muted">한국어(또는 어색한 영어)를 쓰면 원어민이 실제로 말하는 방식으로 바꿔 드려요.</p>
        <textarea id="cIn" rows="3" placeholder="예: 오늘 아이가 열이 좀 있어서 일찍 데리러 왔어요">${esc(prefill)}</textarea>
        <button class="btn primary big" id="cGo" style="margin-top:8px">원어민처럼 바꾸기</button><div id="cOut"></div>`;
      $("#cGo").onclick = () => convert($("#cIn").value.trim(), $("#cOut"));
    }
  };
  $("#toolSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { prefill = ""; show(b.dataset.t); } };
  show(tab);
}
const openWord = (w) => openTools("word", w);

async function wordLookup(word, out) {
  out.innerHTML = `<div class="card"><span class="spinner"></span> 찾는 중…</div>`;
  const simple = /^[a-z' -]{1,40}$/i.test(word);
  const [dict, exp] = await Promise.allSettled([
    simple ? api("/api/dict?w=" + encodeURIComponent(word.toLowerCase())).then((r) => r.data) : Promise.resolve({}),
    ai("word", { word }),
  ]);
  const d = dict.status === "fulfilled" ? dict.value || {} : {};
  const x = exp.status === "fulfilled" ? exp.value || {} : null;
  if (!x && !(d.defs || []).length) { out.innerHTML = `<div class="card empty">찾지 못했어요. ${exp.reason ? esc(exp.reason.message) : ""}</div>`; return; }
  const au = d.audio || {};
  const audioBtn = (reg, label, lang) => au[reg] ? `<button class="btn sm" data-audio="${esc(au[reg])}">🔊 ${label} 원어민</button>` : `<button class="btn sm" data-say="${esc(word)}" data-lang="${lang}">🔊 ${label}</button>`;
  out.innerHTML = `<div class="card">
    <div class="row spread"><h2>${esc(x?.word || word)}</h2><span class="tag">${esc(x?.pos || d.defs?.[0]?.pos || "")}</span></div>
    <div class="row wrap" style="margin:6px 0 10px;gap:12px">
      <span><span class="small muted">US</span> <span class="ipa">${esc(x?.ipaUS || d.phon?.us || "")}</span></span>
      <span><span class="small muted">UK</span> <span class="ipa">${esc(x?.ipaUK || d.phon?.uk || "")}</span></span></div>
    <div class="row wrap">${audioBtn("us", "미국", "en-US")}${audioBtn("uk", "영국", "en-GB")}${au.au ? audioBtn("au", "호주", "en-AU") : ""}</div>
    ${x ? `<p style="font-size:17px;font-weight:700;margin:12px 0 4px">${esc(x.ko)}</p><p class="small muted" style="margin:0">${esc(x.nuance || "")}</p>` : ""}
    ${!x && d.defs ? `<p class="small muted">AI 설명을 불러오지 못해 영영 풀이만 보여 드려요.</p>` + d.defs.map((f) => `<p class="small"><b>${esc(f.pos)}</b> ${esc(f.def)}</p>`).join("") : ""}
    ${x?.collocations?.length ? `<div class="label" style="margin-top:12px">자주 같이 쓰는 말</div><div class="row wrap">${x.collocations.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>` : ""}
  </div>
  ${x?.examples?.length ? `<div class="card"><div class="label">예문</div>${x.examples.map((e) => `<div class="item"><div class="en">${tappable(e.en)}</div><div class="ko">${esc(e.ko)}</div><div class="acts">${sayBtns(e.en)}${starBtn({ en: e.en, ko: e.ko, key: word, src: "단어 " + word })}</div></div>`).join("")}</div>` : ""}
  ${x?.drill?.length ? `<div class="card"><div class="label">이 단어로 말해 보기</div><div id="wDrill"></div></div>` : ""}
  <button class="btn big" id="wSave">${S.words.some((w) => w.w === word.toLowerCase()) ? "★ 단어장에 있음" : "☆ 단어장에 저장"}</button>`;
  out.querySelectorAll("[data-audio]").forEach((b) => (b.onclick = () => new Audio(b.dataset.audio).play().catch(() => speak(word))));
  if (x?.drill?.length) quiz($("#wDrill"), x.drill.map((q) => ({ ...q, src: "단어 " + word })), { kind: "drill", compact: true });
  $("#wSave").onclick = () => {
    const w = word.toLowerCase();
    if (!S.words.some((v) => v.w === w)) { S.words.unshift({ id: "w:" + w, w, ko: x?.ko || d.defs?.[0]?.def || "", at: new Date().toISOString() }); log("words"); toast("단어장에 저장했어요"); }
    $("#wSave").textContent = "★ 단어장에 있음";
  };
  if (!S.words.some((v) => v.w === word.toLowerCase())) {} // 저장은 사용자가 선택
}

async function convert(text, out) {
  if (!text) return;
  out.innerHTML = `<div class="card"><span class="spinner"></span> 바꾸는 중…</div>`;
  try {
    const x = await ai("naturalize", { text });
    const row = (label, en) => en ? `<div class="item"><div class="label">${label}</div><div class="en">${tappable(en, label === "가장 자연스럽게" ? x.key : "")}</div><div class="acts">${sayBtns(en)}${starBtn({ en, ko: x.ko || text, key: x.key, keyKo: x.keyKo, src: "변환" })}</div></div>` : "";
    out.innerHTML = `<div class="card">${row("가장 자연스럽게", x.best)}${row("더 캐주얼 (Kiwi)", x.casual)}${row("더 정중하게", x.polite)}
      ${x.key ? `<div class="keybox"><b>${esc(x.key)}</b> — ${esc(x.keyKo || "")}</div>` : ""}
      ${(x.notes || []).length ? `<ul class="small">${x.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</div>`;
    log("convert");
  } catch (e) { out.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

// ── 퀴즈(영작·드릴·복습 공통) ───────────────────────────
// items: [{ko, en, hint?, sp?, context?}] / opts.kind: write|drill|review / onDone()
function quiz(box, items, opts = {}) {
  let i = 0, results = [];
  const step = () => {
    if (i >= items.length) {
      const ok = results.filter(Boolean).length;
      box.innerHTML = `<div class="result ${ok === items.length ? "ok" : ""}" style="text-align:center"><div class="score">${ok} / ${items.length}</div><p>${ok === items.length ? "완벽해요! 👏" : "틀린 문장은 복습함에 자동으로 들어갔어요."}</p></div>`;
      opts.onDone?.(ok, items.length);
      return;
    }
    const it = items[i];
    const ctx = opts.context ? items.slice(0, i).map((p) => `<div><b>${esc(p.sp || "")}</b>${esc(p.en)}</div>`).join("") : "";
    box.innerHTML = `
      ${opts.compact ? "" : `<div class="row spread small muted"><span>${i + 1} / ${items.length}</span>${it.sp ? `<span class="tag">${esc(it.sp)} 차례</span>` : ""}</div><div class="quiz-prog"><i style="width:${(i / items.length) * 100}%"></i></div>`}
      ${ctx ? `<div class="ctx">${ctx}</div>` : ""}
      <div class="q-ko">${esc(it.ko)}</div>
      ${it.hint ? `<details class="small muted" style="margin-bottom:8px"><summary>힌트</summary>${esc(it.hint)}</details>` : ""}
      <textarea rows="2" id="qIn" placeholder="영어로 써 보세요 (또는 🎙로 말하기)" autocapitalize="sentences"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="qMic">🎙 말하기</button><button class="btn ghost" id="qSkip">모르겠어요</button><button class="btn primary" id="qGo" style="flex:1">확인</button></div>
      <div id="qRes"></div>`;
    const inp = $("#qIn", box);
    if (!opts.compact) inp.focus({ preventScroll: true });
    $("#qMic", box).onclick = async () => {
      const b = $("#qMic", box); b.innerHTML = '<span class="spinner"></span> 듣는 중';
      try { const alts = await listen(); if (alts[0]) inp.value = alts[0]; } catch (e) { toast(e.message); }
      b.textContent = "🎙 말하기";
    };
    $("#qSkip", box).onclick = () => judge("", true);
    $("#qGo", box).onclick = () => inp.value.trim() ? judge(inp.value.trim()) : inp.focus();
    inp.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#qGo", box).click(); } };

    async function judge(mine, skipped = false) {
      const res = $("#qRes", box);
      ["#qGo", "#qMic", "#qSkip"].forEach((s) => ($(s, box).disabled = true));
      let r = null;
      if (!skipped) {
        const sim = similarity(mine, it.en);
        if (sim >= 95) r = { score: 100, ok: true, corrected: mine, natural: it.en, why: "정답과 거의 같아요!" };
        else {
          res.innerHTML = `<div class="result"><span class="spinner"></span> AI 코치가 확인 중…</div>`;
          try { r = await ai("correct", { ko: it.ko, answer: it.en, mine, context: ctx ? items.slice(0, i).map((p) => `${p.sp || ""}: ${p.en}`).join("\n") : "" }); }
          catch (e) { r = { score: sim, ok: sim >= 80, corrected: mine, natural: it.en, why: `AI 확인을 못 해서 정답과 단어 일치율(${sim}%)로만 판단했어요. 맞다고 생각되면 '맞은 걸로'를 눌러요.`, offline: true }; }
        }
      } else r = { score: 0, ok: false, corrected: "", natural: it.en, why: "정답을 소리 내어 3번 따라 말해 보세요." };
      const ok = !!r.ok;
      res.innerHTML = `<div class="result ${ok ? "ok" : "no"}">
        <div class="row spread"><span class="score">${ok ? "👍" : "✍️"} ${r.score ?? ""}</span><span class="tag ${ok ? "good" : "bad"}">${ok ? "통과" : "복습함에 저장"}</span></div>
        ${mine && r.corrected && norm(r.corrected) !== norm(mine) ? `<div class="pair"><small>교정</small>${esc(r.corrected)}</div>` : ""}
        <div class="pair"><small>원어민이라면</small><span class="en">${tappable(r.natural || it.en)}</span></div>
        ${norm(r.natural) !== norm(it.en) ? `<div class="pair"><small>모범 답안</small>${esc(it.en)}</div>` : ""}
        ${r.why ? `<p class="small" style="margin:8px 0 0">${esc(r.why)}</p>` : ""}
        ${(r.points || []).length ? `<ul>${r.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        <div class="acts">${sayBtns(r.natural || it.en)}${starBtn({ en: r.natural || it.en, ko: it.ko, src: opts.src || "" })}</div>
      </div>
      <div class="row" style="margin-top:10px">${!ok && r.offline ? `<button class="btn" id="qOk">맞은 걸로</button>` : ""}<button class="btn primary big" id="qNext">${i + 1 < items.length ? "다음 →" : "결과 보기"}</button></div>`;
      let final = ok;
      const record = () => {
        if (opts.kind === "review") reviewResult(it._ref, final);
        else if (!final) addWrong({ ...it, src: opts.src || it.src }, mine, r);
        results.push(final);
        if (opts.kind) log(opts.kind === "review_saved" ? "review" : opts.kind);
        opts.onEach?.(it, final, i);
      };
      if ($("#qOk", box)) $("#qOk", box).onclick = () => { final = true; $("#qOk", box).remove(); toast("맞은 걸로 처리했어요"); };
      $("#qNext", box).onclick = () => { record(); i++; step(); };
      if (ok) speak(r.natural || it.en);
    }
  };
  step();
}

// ── 화면 ────────────────────────────────────────────────
const TITLES = { home: "홈", speak: "오늘의 스피킹", write: "영작 훈련", train: "동사·5형식", vault: "복습·보관함" };
let TAB = "home";
function go(tab) {
  if (!TITLES[tab]) tab = "home";
  TAB = tab;
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", "#" + tab);
  render();
  window.scrollTo(0, 0);
}
function render() {
  if (!S) return;
  $("#topTitle").textContent = TITLES[TAB];
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === TAB));
  const due = dueItems().length; const bd = $("#dueBadge"); bd.hidden = !due; bd.textContent = due;
  ({ home: renderHome, speak: renderSpeak, write: renderWrite, train: renderTrain, vault: renderVault })[TAB]($("#view"));
}
$("#tabbar").onclick = (e) => { const b = e.target.closest("button"); if (b) go(b.dataset.tab); };
$("#toolsBtn").onclick = () => openTools();
$("#codeChip").onclick = () => {
  openSheet(`<h2>코드 ${esc(CODE)}</h2><p class="small muted">${esc($("#syncDot").title)}</p>
    <div class="card tight small">학습을 시작한 날: ${esc(S.created)}<br>저장 문장 ${S.saved.length} · 시나리오 ${S.scenarios.length} · 복습 ${S.wrong.filter((w) => !w.mastered).length} · 단어 ${S.words.length}</div>
    <div class="label">발음 기본값</div><div class="seg" id="accSeg">${[["en-US", "미국"], ["en-GB", "영국"], ["en-NZ", "뉴질랜드"], ["en-AU", "호주"]].map(([v, l]) => `<button data-v="${v}" class="${S.settings.accent === v ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="label">말하기 속도</div><div class="seg" id="rateSeg">${[[0.8, "천천히"], [0.95, "보통"], [1.1, "빠르게"]].map(([v, l]) => `<button data-v="${v}" class="${S.settings.rate == v ? "on" : ""}">${l}</button>`).join("")}</div>
    <p class="small muted">기기에 뉴질랜드 음성이 없으면 비슷한 영어 음성으로 재생돼요.</p>
    <button class="btn big" id="syncNow" style="margin-top:6px">지금 동기화</button>
    <button class="btn big ghost" id="logout" style="margin-top:8px">다른 코드로 바꾸기</button>`);
  $("#accSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.settings.accent = b.dataset.v; save(); [...$("#accSeg").children].forEach((x) => x.classList.toggle("on", x === b)); speak("Kia ora, how's it going?"); };
  $("#rateSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.settings.rate = +b.dataset.v; save(); [...$("#rateSeg").children].forEach((x) => x.classList.toggle("on", x === b)); };
  $("#syncNow").onclick = async () => { dirty = true; await push(); toast($("#syncDot").title); };
  $("#logout").onclick = async () => { if (dirty) await push(); lsDel("et:code"); location.hash = ""; location.reload(); };
};

// 오늘의 콘텐츠
const allScenarios = () => [...SCENARIOS, ...S.scenarios.filter((s) => !s.del)];
function todayScenario() {
  const pick = S.done["pick:" + today()];
  return allScenarios().find((s) => s.id === pick) || SCENARIOS[dayNum(today()) % SCENARIOS.length];
}
function todayWriting() {
  const pick = S.done["wpick:" + today()];
  const custom = S.scenarios.filter((s) => s.kind === "writing");
  return [...WRITING_SETS, ...custom].find((s) => s.id === pick) || WRITING_SETS[dayNum(today()) % WRITING_SETS.length];
}

// 홈
function renderHome(v) {
  const h = todayH(), due = dueItems().length, sc = todayScenario(), ws = todayWriting();
  const speakN = Math.min(h.speak || 0, 12), writeN = Math.min(h.write || 0, 10), drillN = h.drill || 0;
  const days = [...Array(7)].map((_, k) => addDays(today(), k - 6));
  const tot = (d) => Object.values(S.history[d] || {}).reduce((a, b) => a + b, 0);
  const mx = Math.max(10, ...days.map(tot));
  const hour = +new Intl.DateTimeFormat("en-NZ", { hour: "numeric", hour12: false, timeZone: "Pacific/Auckland" }).format(new Date());
  const greet = hour < 12 ? "Morning! ☀️" : hour < 18 ? "Kia ora! 👋" : "Evening! 🌙";
  const totalSentences = Object.values(S.history).reduce((a, x) => a + (x.speak || 0) + (x.write || 0) + (x.drill || 0) + (x.review || 0), 0);
  v.innerHTML = `
    <div class="hello"><h2>${greet}</h2><p class="muted" style="margin:2px 0 0">오늘도 짧게, 소리 내서. 코드 <b>${esc(CODE)}</b></p></div>
    <div class="stats" style="margin-top:12px">
      <div class="stat"><b>🔥 ${streak()}</b><span>연속 학습일</span></div>
      <div class="stat"><b>${totalSentences}</b><span>누적 연습 문장</span></div>
      <div class="stat"><b>${S.saved.length}</b><span>저장 문장</span></div>
    </div>
    <div class="card">
      <div class="row spread"><h3>오늘의 할 일</h3><span class="small muted">${esc(today())}</span></div>
      <div class="task" data-go="speak"><div class="ring" style="--p:${(speakN / 12) * 100}">${speakN}/12</div><div class="t"><b>스피킹 12문장</b><span>${esc(sc.title)}</span></div>›</div>
      <div class="task" data-go="write"><div class="ring" style="--p:${(writeN / 10) * 100}">${writeN}/10</div><div class="t"><b>영작 10문장</b><span>${esc(ws.title)}</span></div>›</div>
      <div class="task" data-go="train"><div class="ring" style="--p:${Math.min(drillN / 10, 1) * 100}">${drillN}</div><div class="t"><b>기본동사 · 5형식</b><span>오늘 ${drillN}문장 · 목표 10</span></div>›</div>
      <div class="task" data-go="vault"><div class="ring" style="--p:${due ? 0 : 100}">${due}</div><div class="t"><b>복습</b><span>${due ? `오늘 다시 볼 문장 ${due}개` : "오늘 복습 끝! 👍"}</span></div>›</div>
    </div>
    <div class="card">
      <h3>최근 7일</h3>
      <div class="bars">${days.map((d) => `<div class="${d === today() ? "today" : ""}"><i style="height:${(tot(d) / mx) * 70}px" title="${tot(d)}"></i><span>${"일월화수목금토"[new Date(d + "T12:00:00Z").getUTCDay()]}</span></div>`).join("")}</div>
    </div>
    <div class="card">
      <h3>이 말, 영어로 뭐라고 하지?</h3>
      <p class="small muted" style="margin:4px 0 8px">한국어를 쓰면 원어민 말투로 바꿔 드려요.</p>
      <div class="row"><input class="text" id="qConv" placeholder="예: 우리 애가 오늘 좀 피곤해 보여요"><button class="btn primary" id="qConvGo">변환</button></div>
    </div>`;
  v.querySelectorAll("[data-go]").forEach((t) => (t.onclick = () => go(t.dataset.go)));
  $("#qConvGo").onclick = () => { const t = $("#qConv").value.trim(); openTools("conv", t); if (t) convert(t, $("#cOut")); };
  $("#qConv").onkeydown = (e) => { if (e.key === "Enter") $("#qConvGo").click(); };
}

// 스피킹
let speakMode = "read", rolePick = "A", revealed = new Set();
function renderSpeak(v) {
  const sc = todayScenario();
  const doneKey = "speak:" + today() + ":" + sc.id;
  const savedScn = S.scenarios.some((s) => s.id === sc.id) || SCENARIOS.some((s) => s.id === sc.id && S.done["fav:" + sc.id]);
  v.innerHTML = `
    <div class="chips" id="scnChips">
      <button class="chip" id="newScn">＋ 직접 입력</button>
      ${allScenarios().filter((s) => s.kind !== "writing").map((s) => `<button class="chip ${s.id === sc.id ? "on" : ""}" data-id="${esc(s.id)}">${S.done["speak:done:" + s.id] ? "✓ " : ""}${esc(s.title.split(" — ")[0])}</button>`).join("")}
    </div>
    <div class="card scn-head">
      <div class="row spread"><span class="tag">${sc.custom ? "내 시나리오" : "필수 세트"}</span><span class="small muted">A·B 각 6문장</span></div>
      <h2 style="margin-top:8px">${esc(sc.title)}</h2>
      <p class="small muted" style="margin:4px 0 0">${esc(sc.setting || "")}</p>
      <div class="roles"><span class="tag">A ${esc(sc.roles?.A || "")}</span><span class="tag" style="background:var(--b-bubble)">B ${esc(sc.roles?.B || "")}</span></div>
      <div class="seg" id="modeSeg" style="margin-top:12px">
        <button data-m="read">전체 보기</button><button data-m="hide">가리고 말하기</button><button data-m="role">역할 연습</button>
      </div>
      ${speakMode === "role" ? `<div class="row small" style="gap:6px"><span class="muted">내 역할</span><div class="seg" id="roleSeg" style="flex:1;margin:0"><button data-r="A">A ${esc(sc.roles?.A || "")}</button><button data-r="B">B ${esc(sc.roles?.B || "")}</button></div></div>` : ""}
      <p class="small muted" style="margin:6px 0 0">${speakMode === "read" ? "단어를 누르면 뜻·발음을 볼 수 있어요. 노란색은 꼭 익힐 핵심 표현." : speakMode === "hide" ? "한국어를 보고 먼저 영어로 말한 뒤, 문장을 눌러 확인하세요." : "상대 대사는 자동으로 읽어 주고, 내 차례에 🎙로 말해 보세요."}</p>
    </div>
    <div class="dlg" id="dlg"></div>
    <div class="sticky-actions">
      <button class="btn" id="playAll">▶ 전체 듣기</button>
      <button class="btn" id="saveScn">${savedScn ? "★ 보관됨" : "☆ 시나리오 보관"}</button>
      <button class="btn primary" id="doneScn">${S.done[doneKey] ? "✓ 오늘 완료" : "완료 기록"}</button>
    </div>`;
  [...$("#modeSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.m === speakMode));
  $("#modeSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { speakMode = b.dataset.m; revealed.clear(); renderSpeak(v); } };
  if ($("#roleSeg")) { [...$("#roleSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.r === rolePick)); $("#roleSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { rolePick = b.dataset.r; renderSpeak(v); } }; }
  $("#scnChips").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "newScn") return newScenarioSheet();
    S.done["pick:" + today()] = b.dataset.id; save(); revealed.clear(); renderSpeak(v);
  };
  const dlg = $("#dlg");
  const mine = (ln) => speakMode === "role" && ln.sp === rolePick;
  dlg.innerHTML = sc.lines.map((ln, i) => {
    const hide = (speakMode === "hide" || mine(ln)) && !revealed.has(i);
    const o = { en: ln.en, ko: ln.ko, key: ln.key, keyKo: ln.keyKo, src: sc.title };
    return `<div class="line ${ln.sp}" data-i="${i}"><div class="av">${ln.sp}</div><div class="bubble">
      ${hide ? `<div class="ko" style="font-size:16px;color:var(--text);margin:0 0 6px">${esc(ln.ko)}</div><div class="en hidden-en" data-reveal="${i}">${esc(ln.en)}</div>`
        : `<div class="en">${tappable(ln.en, ln.key)}</div>${S.settings.showKo ? `<div class="ko">${esc(ln.ko)}</div>` : ""}`}
      ${!hide && ln.key ? `<div class="keybox"><b>${esc(ln.key)}</b> — ${esc(ln.keyKo || "")}</div>` : ""}
      ${!hide && ln.tip ? `<div class="tip">${esc(ln.tip)}</div>` : ""}
      <div class="acts">${sayBtns(ln.en)}<button class="act" data-shadow="${i}">🎙 따라 말하기</button>${starBtn(o)}</div>
      <div class="shadow-res" id="sr${i}"></div></div></div>`;
  }).join("");
  dlg.onclick = async (e) => {
    const rv = e.target.closest("[data-reveal]");
    if (rv) { revealed.add(+rv.dataset.reveal); renderSpeak(v); speak(sc.lines[+rv.dataset.reveal].en); return; }
    const sh = e.target.closest("[data-shadow]");
    if (sh) {
      const i = +sh.dataset.shadow, out = $("#sr" + i);
      out.innerHTML = '<span class="spinner"></span> 말해 보세요…';
      try {
        const alts = await listen();
        if (!alts.length) { out.textContent = "소리가 안 들렸어요. 다시 눌러 주세요."; return; }
        const best = alts.map((a) => [a, similarity(a, sc.lines[i].en)]).sort((a, b) => b[1] - a[1])[0];
        out.innerHTML = `<span class="tag ${best[1] >= 80 ? "good" : "bad"}">${best[1]}%</span> <span class="muted">들린 말: “${esc(best[0])}”</span>`;
        if (best[1] >= 80) { log("shadow"); } else toast("천천히 한 단어씩 또박또박 다시 해 보세요");
      } catch (err) { out.textContent = err.message; }
    }
  };
  let playing = false;
  $("#playAll").onclick = async () => {
    if (playing) { playing = false; window.speechSynthesis?.cancel(); $("#playAll").textContent = "▶ 전체 듣기"; return; }
    playing = true; $("#playAll").textContent = "■ 멈춤";
    for (let i = 0; i < sc.lines.length && playing; i++) {
      const el = dlg.querySelector(`[data-i="${i}"]`); dlg.querySelectorAll(".line").forEach((l) => l.classList.remove("now")); el.classList.add("now");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      if (speakMode === "role" && sc.lines[i].sp === rolePick) { await new Promise((r) => setTimeout(r, Math.max(2500, sc.lines[i].en.length * 90))); continue; }
      await speak(sc.lines[i].en, sc.lines[i].sp === "B" && S.settings.accent === "en-US" ? "en-GB" : undefined);
      await new Promise((r) => setTimeout(r, 350));
    }
    playing = false; $("#playAll").textContent = "▶ 전체 듣기"; dlg.querySelectorAll(".line").forEach((l) => l.classList.remove("now"));
  };
  $("#saveScn").onclick = () => {
    if (sc.custom) { toast("내 시나리오는 이미 보관돼 있어요"); return; }
    S.done["fav:" + sc.id] = !S.done["fav:" + sc.id]; save(); renderSpeak(v);
  };
  $("#doneScn").onclick = () => {
    if (S.done[doneKey]) { toast("오늘 이미 기록했어요. 한 번 더 들어도 좋아요!"); return; }
    S.done[doneKey] = 1; S.done["speak:done:" + sc.id] = today(); log("speak", 12); toast("스피킹 12문장 완료! 🔥"); renderSpeak(v);
  };
}

function newScenarioSheet() {
  openSheet(`<h2>내 시나리오 만들기</h2>
    <p class="small muted">상황을 자세히 쓸수록 좋아요. AI가 A·B 각 6문장, 핵심 표현과 해석까지 만들어 내 보관함에 저장해요.</p>
    <textarea id="scnIn" rows="3" placeholder="예: 어린이집 하원 때 선생님에게 오늘 아이 특이사항 묻고 가벼운 스몰토크"></textarea>
    <div class="label" style="margin-top:10px">난이도</div>
    <div class="seg" id="lvSeg"><button data-l="easy">쉽게</button><button data-l="intermediate" class="on">보통</button><button data-l="advanced">원어민 수준</button></div>
    <div class="label">추천 상황</div>
    <div class="chips" style="flex-wrap:wrap">${SCENARIO_IDEAS.map((s) => `<button class="chip" data-idea="${esc(s)}">${esc(s)}</button>`).join("")}</div>
    <button class="btn primary big" id="scnGo" style="margin-top:12px">AI로 12문장 만들기</button><div id="scnOut"></div>`);
  let lv = "intermediate";
  $("#lvSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; lv = b.dataset.l; [...$("#lvSeg").children].forEach((x) => x.classList.toggle("on", x === b)); };
  $("#sheetBody").querySelectorAll("[data-idea]").forEach((b) => (b.onclick = () => ($("#scnIn").value = b.dataset.idea)));
  $("#scnGo").onclick = async () => {
    const scenario = $("#scnIn").value.trim(); if (!scenario) return $("#scnIn").focus();
    $("#scnGo").disabled = true; $("#scnOut").innerHTML = `<div class="card"><span class="spinner"></span> 대화 만드는 중… (10~20초)</div>`;
    try {
      const x = await ai("dialogue", { scenario, level: lv });
      const lines = (x.lines || []).filter((l) => l.en).slice(0, 12).map((l, i) => ({ sp: l.sp === "B" ? "B" : l.sp === "A" ? "A" : i % 2 ? "B" : "A", en: l.en, ko: l.ko || "", key: l.key || "", keyKo: l.keyKo || "", tip: l.tip || "" }));
      if (lines.length < 6) throw new Error("대화가 너무 짧게 나왔어요. 다시 시도해 주세요");
      const sc = { id: "c-" + uid(), custom: true, title: x.title || scenario.slice(0, 30), setting: x.setting || scenario, roles: x.roles || { A: "나", B: "상대" }, lines, prompt: scenario, at: new Date().toISOString() };
      S.scenarios.unshift(sc); S.done["pick:" + today()] = sc.id; save();
      closeSheet(); go("speak"); toast("내 시나리오에 저장했어요");
    } catch (e) { $("#scnOut").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; $("#scnGo").disabled = false; }
  };
}

// 영작
function renderWrite(v) {
  const ws = todayWriting();
  const custom = S.scenarios.filter((s) => s.kind === "writing");
  const doneKey = "write:" + today() + ":" + ws.id;
  v.innerHTML = `
    <div class="chips" id="wsChips"><button class="chip" id="newWs">＋ 새 주제 (AI)</button>
      ${[...WRITING_SETS, ...custom].map((s) => `<button class="chip ${s.id === ws.id ? "on" : ""}" data-id="${esc(s.id)}">${S.done["write:done:" + s.id] ? "✓ " : ""}${esc(s.title)}</button>`).join("")}</div>
    <div class="card"><div class="row spread"><span class="tag">대화형 영작 10문장</span>${S.done[doneKey] ? '<span class="tag good">오늘 완료</span>' : ""}</div>
      <h2 style="margin-top:8px">${esc(ws.title)}</h2>
      <p class="small muted" style="margin:4px 0 0">앞 문장이 쌓이며 대화가 이어져요. 한국어를 보고 말하듯이 써 보세요. AI 코치가 원어민식으로 고쳐 주고, 틀린 문장은 복습함에 자동 저장돼요.</p>
      <div id="wQuiz" style="margin-top:12px"><button class="btn primary big" id="wStart">시작하기</button></div></div>`;
  $("#wsChips").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "newWs") return newWritingSheet();
    S.done["wpick:" + today()] = b.dataset.id; save(); renderWrite(v);
  };
  $("#wStart").onclick = () => quiz($("#wQuiz"), ws.lines.map((l) => ({ ...l })), {
    kind: "write", context: true, src: "영작 " + ws.title,
    onDone: () => { S.done[doneKey] = 1; S.done["write:done:" + ws.id] = today(); save(); },
  });
}
function newWritingSheet() {
  openSheet(`<h2>새 영작 주제</h2><p class="small muted">주제를 쓰면 AI가 10문장 대화(A·B)를 만들어요.</p>
    <input class="text" id="wsIn" placeholder="예: 아이 학교 캠프 준비물 물어보기">
    <button class="btn primary big" id="wsGo" style="margin-top:10px">10문장 만들기</button><div id="wsOut"></div>`);
  $("#wsGo").onclick = async () => {
    const topic = $("#wsIn").value.trim(); if (!topic) return;
    $("#wsGo").disabled = true; $("#wsOut").innerHTML = `<div class="card"><span class="spinner"></span> 만드는 중…</div>`;
    try {
      const x = await ai("writing", { topic });
      const lines = (x.lines || []).filter((l) => l.ko && l.en).slice(0, 10).map((l, i) => ({ sp: l.sp || (i % 2 ? "B" : "A"), ko: l.ko, en: l.en, hint: l.hint || "" }));
      if (lines.length < 5) throw new Error("다시 시도해 주세요");
      const ws = { id: "cw-" + uid(), kind: "writing", custom: true, title: x.title || topic, lines, at: new Date().toISOString() };
      S.scenarios.unshift(ws); S.done["wpick:" + today()] = ws.id; save(); closeSheet(); go("write");
    } catch (e) { $("#wsOut").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; $("#wsGo").disabled = false; }
  };
}

// 훈련: 기본동사 · 5형식
let trainMode = "verb", verbPick = null, formPick = null;
function partsHtml(p) {
  if (!p) return "";
  return `<div class="parts">${p.split("|").map((s) => { const m = s.match(/\((S|V|O|C|IO|DO|OC)\)/); return `<span class="${m ? m[1] : ""}">${esc(s.trim())}</span>`; }).join("")}</div>`;
}
function renderTrain(v) {
  verbPick = verbPick || VERBS[dayNum(today()) % VERBS.length].v;
  formPick = formPick || (dayNum(today()) % 5) + 1;
  const isVerb = trainMode === "verb";
  const set = isVerb ? VERBS.find((x) => x.v === verbPick) : FORMS.find((f) => f.n === formPick);
  const extraKey = (isVerb ? "verb:" : "form:") + (isVerb ? verbPick : formPick);
  const extra = (S.done["ai:" + extraKey] || []);
  const items = [...set.items, ...extra];
  v.innerHTML = `
    <div class="seg" id="trSeg"><button data-m="verb">기본동사</button><button data-m="form">5형식</button></div>
    <div class="chips" id="trChips">${isVerb ? VERBS.map((x) => `<button class="chip ${x.v === verbPick ? "on" : ""}" data-k="${x.v}">${x.v}</button>`).join("")
      : FORMS.map((f) => `<button class="chip ${f.n === formPick ? "on" : ""}" data-k="${f.n}">${f.n}형식</button>`).join("")}</div>
    <div class="card">
      <h2>${isVerb ? esc(set.v) : esc(set.name)}</h2>
      <p class="verb-core">${esc(isVerb ? "핵심 이미지: " + set.core : set.desc)}</p>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="trQuiz" style="flex:1">✍️ 영작 퀴즈 ${items.length}문장</button><button class="btn" id="trMore">＋ AI 새 문장</button></div>
      <div id="trQ"></div>
    </div>
    <div class="card" id="trList">${items.map((it) => `<div class="item"><div class="en">${tappable(it.en)}</div><div class="ko">${esc(it.ko)}</div>
      ${isVerb ? `<div class="small muted" style="margin-top:4px">${esc(it.note || "")}</div>` : partsHtml(it.parts)}
      <div class="acts">${sayBtns(it.en)}${starBtn({ en: it.en, ko: it.ko, key: isVerb ? set.v : "", keyKo: it.note || "", src: isVerb ? "동사 " + set.v : set.name })}</div></div>`).join("")}</div>`;
  [...$("#trSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.m === trainMode));
  $("#trSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { trainMode = b.dataset.m; renderTrain(v); } };
  $("#trChips").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; if (isVerb) verbPick = b.dataset.k; else formPick = +b.dataset.k; renderTrain(v); };
  $("#trQuiz").onclick = () => { $("#trList").hidden = true; quiz($("#trQ"), items.map((it) => ({ ko: it.ko, en: it.en, hint: isVerb ? set.v + " 사용" : set.name })), { kind: "drill", src: isVerb ? "동사 " + set.v : set.name, onDone: () => ($("#trList").hidden = false) }); };
  $("#trMore").onclick = async () => {
    const b = $("#trMore"); b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
    try {
      const x = await ai("drill", { kind: isVerb ? "verb" : "form", item: isVerb ? set.v : set.name });
      const add = (x.items || []).filter((i) => i.en && i.ko).map((i) => ({ en: i.en, ko: i.ko, note: i.note || "", parts: i.parts || "" }));
      S.done["ai:" + extraKey] = [...add, ...extra].slice(0, 30); save(); renderTrain(v); toast(`새 문장 ${add.length}개 추가`);
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = "＋ AI 새 문장"; }
  };
}

// 복습·보관함
let vaultMode = "due", vaultQ = "";
function renderVault(v) {
  const due = dueItems();
  const scns = [...S.scenarios.filter((s) => !s.del), ...SCENARIOS.filter((s) => S.done["fav:" + s.id])];
  const q = norm(vaultQ);
  const f = (arr, keys) => !q ? arr : arr.filter((x) => keys.some((k) => norm(x[k]).includes(q) || String(x[k] || "").includes(vaultQ)));
  v.innerHTML = `
    <div class="seg" id="vSeg"><button data-m="due">복습 ${due.length ? `(${due.length})` : ""}</button><button data-m="saved">저장 문장</button><button data-m="scn">시나리오</button><button data-m="words">단어</button></div>
    ${vaultMode !== "due" ? `<input class="text" id="vSearch" placeholder="검색" value="${esc(vaultQ)}" style="margin:4px 0 8px">` : ""}
    <div id="vBody"></div>`;
  [...$("#vSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.m === vaultMode));
  $("#vSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { vaultMode = b.dataset.m; renderVault(v); } };
  if ($("#vSearch")) $("#vSearch").oninput = (e) => { vaultQ = e.target.value; clearTimeout(renderVault._t); renderVault._t = setTimeout(() => { renderVault(v); const s = $("#vSearch"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250); };
  const body = $("#vBody");
  if (vaultMode === "due") {
    const waiting = S.wrong.filter((w) => !w.del && !w.mastered && w.due > today()).sort((a, b) => a.due.localeCompare(b.due));
    const mastered = S.wrong.filter((w) => w.mastered).length;
    body.innerHTML = `<div class="card">${due.length ? `<div class="row spread"><h3>오늘 복습 ${due.length}문장</h3><span class="small muted">1·3·7·14·30·60일 간격</span></div><div id="rvQ" style="margin-top:10px"><button class="btn primary big" id="rvGo">복습 시작</button></div>`
      : `<div class="empty">🎉 오늘 복습할 문장이 없어요.<br><span class="small">영작·퀴즈에서 틀린 문장이 여기로 자동으로 들어와요.</span></div>`}</div>
      ${waiting.length ? `<div class="card"><div class="row spread"><h3>대기 중 ${waiting.length}</h3><span class="small muted">완전히 익힘 ${mastered}</span></div>${waiting.slice(0, 40).map((w) => `<div class="item"><div class="row spread"><span class="small muted">${esc(w.due)} 복습 · ${w.box || 0}단계</span><button class="act" data-delw="${w.id}">삭제</button></div><div class="ko" style="color:var(--text)">${esc(w.ko)}</div><div class="en">${esc(w.en)}</div>${w.mine ? `<div class="small muted">내 답: ${esc(w.mine)}</div>` : ""}</div>`).join("")}</div>` : ""}`;
    if ($("#rvGo")) $("#rvGo").onclick = () => quiz($("#rvQ"), due.map((w) => ({ ko: w.ko, en: w.en, _ref: w })), { kind: "review", onDone: () => render() });
    body.querySelectorAll("[data-delw]").forEach((b) => (b.onclick = () => { S.wrong = S.wrong.filter((w) => w.id !== b.dataset.delw); save(); renderVault(v); }));
  } else if (vaultMode === "saved") {
    const list = f(S.saved, ["en", "ko", "src"]);
    body.innerHTML = list.length ? `<div class="row spread small muted" style="margin:0 2px"><span>${list.length}문장</span><button class="btn sm" id="svQuiz">저장 문장으로 퀴즈</button></div><div id="svQ"></div><div class="card">${list.map((s) => `<div class="item"><div class="en">${tappable(s.en, s.key)}</div><div class="ko">${esc(s.ko)}</div>${s.keyKo ? `<div class="keybox"><b>${esc(s.key)}</b> — ${esc(s.keyKo)}</div>` : ""}<div class="acts">${sayBtns(s.en)}<span class="small muted" style="margin-left:auto">${esc(s.src || "")}</span><button class="act" data-dels="${s.id}">삭제</button></div></div>`).join("")}</div>`
      : `<div class="card empty">☆ 저장 버튼을 누른 문장이 여기에 모여요.</div>`;
    body.querySelectorAll("[data-dels]").forEach((b) => (b.onclick = () => { S.saved = S.saved.filter((s) => s.id !== b.dataset.dels); save(); renderVault(v); }));
    if ($("#svQuiz")) $("#svQuiz").onclick = () => { const pick = list.filter((s) => s.ko).sort(() => Math.random() - 0.5).slice(0, 10); if (!pick.length) return toast("한국어 해석이 있는 문장이 없어요"); $("#svQuiz").remove(); quiz($("#svQ"), pick.map((s) => ({ ko: s.ko, en: s.en })), { kind: "review_saved", src: "저장 문장" }); };
  } else if (vaultMode === "scn") {
    const list = f(scns, ["title", "setting", "prompt"]);
    body.innerHTML = list.length ? `<div class="card">${list.map((s) => `<div class="item"><div class="row spread"><b>${esc(s.title)}</b><span class="tag">${s.kind === "writing" ? "영작" : s.custom ? "내 시나리오" : "필수"}</span></div><div class="small muted">${esc(s.setting || "")} · ${s.lines.length}문장${s.at ? " · " + esc(s.at.slice(0, 10)) : ""}</div><div class="acts"><button class="act" data-open="${esc(s.id)}" data-k="${s.kind || ""}">열기</button><button class="act" data-copy="${esc(s.id)}">전체 문장 복사</button>${s.custom ? `<button class="act" data-delc="${esc(s.id)}">삭제</button>` : `<button class="act" data-unfav="${esc(s.id)}">보관 해제</button>`}</div></div>`).join("")}</div>`
      : `<div class="card empty">스피킹 화면에서 '☆ 시나리오 보관' 또는 '＋ 직접 입력'으로 만든 시나리오가 여기에 보관돼요.</div>`;
    body.onclick = (e) => {
      const o = e.target.closest("[data-open]"), c = e.target.closest("[data-copy]"), d = e.target.closest("[data-delc]"), u = e.target.closest("[data-unfav]");
      if (o) { if (o.dataset.k === "writing") { S.done["wpick:" + today()] = o.dataset.open; save(); go("write"); } else { S.done["pick:" + today()] = o.dataset.open; save(); go("speak"); } }
      if (c) { const s = scns.find((x) => x.id === c.dataset.copy); const txt = s.title + "\n\n" + s.lines.map((l) => `${l.sp}: ${l.en}\n   ${l.ko}`).join("\n"); navigator.clipboard?.writeText(txt).then(() => toast("복사했어요"), () => toast("복사 실패")); }
      if (d && confirm("이 시나리오를 삭제할까요?")) { S.scenarios = S.scenarios.filter((x) => x.id !== d.dataset.delc); save(); renderVault(v); }
      if (u) { S.done["fav:" + u.dataset.unfav] = false; save(); renderVault(v); }
    };
  } else {
    const list = f(S.words, ["w", "ko"]);
    body.innerHTML = list.length ? `<div class="card">${list.map((w) => `<div class="item row spread"><div><b class="w" data-w="${esc(w.w)}" style="cursor:pointer">${esc(w.w)}</b><div class="ko">${esc(w.ko)}</div></div><div class="row"><button class="act" data-say="${esc(w.w)}" data-lang="en-US">🔊 US</button><button class="act" data-say="${esc(w.w)}" data-lang="en-GB">🔊 UK</button><button class="act" data-delword="${esc(w.id)}">삭제</button></div></div>`).join("")}</div>`
      : `<div class="card empty">문장 속 단어를 누르거나 🔍 검색에서 저장한 단어가 모여요.</div>`;
    body.querySelectorAll("[data-delword]").forEach((b) => (b.onclick = () => { S.words = S.words.filter((w) => w.id !== b.dataset.delword); save(); renderVault(v); }));
  }
}

// ── 시작 ────────────────────────────────────────────────
window.addEventListener("hashchange", () => S && go(location.hash.slice(1)));
$("#loginForm").onsubmit = (e) => {
  e.preventDefault();
  const c = $("#codeInput").value.trim();
  if (!/^[A-Za-z0-9가-힣_-]{4,24}$/.test(c)) { toast("코드는 4~24자 (영문·숫자·한글·-_)"); return; }
  login(c);
};
const remembered = lsGet("et:code");
if (remembered) login(remembered); else { $("#login").hidden = false; $("#codeInput").focus(); }
})();
