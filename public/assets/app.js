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
const blank = () => ({ v: 1, rev: 0, created: today(), saved: [], scenarios: [], wrong: [], words: [], history: {}, done: {}, expr: {}, speak: {}, train: {}, errors: [], monos: [], monoLog: [], monoWeak: {}, settings: { accent: "en-US", rate: 0.95, showKo: true } });

function fix(s) {
  const b = blank();
  s = Object.assign(b, s || {});
  s.settings = Object.assign(blank().settings, s.settings || {});
  for (const k of ["saved", "scenarios", "wrong", "words", "errors", "monos", "monoLog"]) if (!Array.isArray(s[k])) s[k] = [];
  for (const k of ["expr", "speak", "train", "monoWeak"]) if (!s[k] || typeof s[k] !== "object" || Array.isArray(s[k])) s[k] = {};
  if (!s.cur || typeof s.cur !== "object") s.cur = {};
  s.cur = Object.assign({ items: {}, extra: {}, tests: [], lastTest: "" }, s.cur);
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
  for (const k of ["saved", "scenarios", "wrong", "words", "monos"]) {
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
  for (const [k, v] of Object.entries(a.expr || {})) out.expr[k] = Object.assign({}, v, out.expr[k] || {});
  if (a.cur) {
    for (const [k, v] of Object.entries(a.cur.items || {})) { const c = out.cur.items[k]; if (!c || (v.at || "") > (c.at || "")) out.cur.items[k] = v; }
    for (const [d, v] of Object.entries(a.cur.extra || {})) out.cur.extra[d] = Math.max(out.cur.extra[d] || 0, v);
    const td = new Set(out.cur.tests.map((t) => t.at)); for (const t of a.cur.tests || []) if (!td.has(t.at)) out.cur.tests.push(t);
    if ((a.cur.lastTest || "") > (out.cur.lastTest || "")) out.cur.lastTest = a.cur.lastTest;
  }
  for (const [k, v] of Object.entries(a.speak || {})) { const c = out.speak[k]; if (!c || (v.at || "") > (c.at || "")) out.speak[k] = v; }
  for (const [k, v] of Object.entries(a.train || {})) { const c = out.train[k]; if (!c || (v.n || 0) > (c.n || 0)) out.train[k] = v; }
  const eid = new Set(out.errors.map((e) => e.id));
  for (const e of a.errors || []) if (!eid.has(e.id)) out.errors.push(e);
  out.errors = out.errors.sort((x, y) => (y.at || "").localeCompare(x.at || "")).slice(0, 300);
  const lid = new Set(out.monoLog.map((e) => e.id));
  for (const e of a.monoLog || []) if (!lid.has(e.id)) out.monoLog.push(e);
  out.monoLog = out.monoLog.sort((x, y) => (y.at || "").localeCompare(x.at || "")).slice(0, 300);
  for (const [k, v] of Object.entries(a.monoWeak || {})) { const c = out.monoWeak[k]; if (!c || (v.n || 0) > (c.n || 0)) out.monoWeak[k] = v; }
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
// 오프라인 앱(홈 화면 설치): 서비스 워커 등록 + 설치 안내
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost"))
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
addEventListener("appinstalled", () => { installPrompt = null; toast("홈 화면에 설치했어요 📱"); });
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
function installHtml() {
  if (isStandalone()) return `<p class="small muted">✅ 홈 화면 앱으로 실행 중이에요. 인터넷이 끊겨도 화면이 열리고, 기록은 연결되면 자동으로 올라가요.</p>`;
  if (installPrompt) return `<button class="btn big" id="installApp" style="margin-top:6px">📱 홈 화면에 앱 설치</button><p class="small muted">설치하면 주소창 없이 앱처럼 열리고, 오프라인에서도 복습·낭독 화면이 열려요.</p>`;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return `<p class="small muted">📱 홈 화면에 설치: Safari 아래쪽 <b>공유</b> 버튼 → <b>홈 화면에 추가</b>. 설치하면 오프라인에서도 열려요.</p>`;
  return `<p class="small muted">📱 브라우저 메뉴(⋮)의 <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>로 설치할 수 있어요.</p>`;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && dirty) push(); });


// 한자·가나 제거 (AI 가 한국어 풀이에 섞은 경우). 바뀐 게 있으면 true
const HAN_RE = /[\u2E80-\u2FDF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF66-\uFF9F]/g;
function cleanHan(o) {
  let changed = false;
  const fix = (v) => {
    if (typeof v === "string") {
      if (!HAN_RE.test(v)) { HAN_RE.lastIndex = 0; return v; }
      HAN_RE.lastIndex = 0; changed = true;
      return v.replace(HAN_RE, "").replace(/\(\s*\)/g, "").replace(/\s+([,.!?])/g, "$1").replace(/,\s*,/g, ",").replace(/^[,\s]+|[,\s]+$/g, "").replace(/\s{2,}/g, " ");
    }
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") { for (const k of Object.keys(v)) v[k] = fix(v[k]); }
    return v;
  };
  fix(o);
  return changed;
}

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
  const cleaned = cleanHan(S);   // 예전에 저장된 시나리오·문장에 섞인 한자 제거
  let back = false;              // 이전에 저장한 문장의 핵심 표현을 표현 마스터에 등록
  for (const sv of S.saved) if (sv.key) { const id = exprId(sv.key); if (id && !S.expr[id]) { S.expr[id] = { k: sv.key, ko: sv.keyKo || "", seen: (sv.at || today()).slice(0, 10) }; back = true; } }
  if (cleaned || back) save();
  lsSet("et:s:" + CODE, JSON.stringify(S));
  $("#login").hidden = true; $("#app").hidden = false;
  $("#codeLabel").textContent = maskCode(CODE);
  go(location.hash.slice(1) || "home");
  takePendingAdd();
}
let rvAddCtx = null;   // 외부에서 보낸 문장의 출처({from:"news", ko}) — 검토 요청·출처 표시에 사용
function takePendingAdd() {
  let p = null; try { p = JSON.parse(sessionStorage.getItem("et:pendingAdd") || "null"); sessionStorage.removeItem("et:pendingAdd"); } catch {}
  if (!p || !p.text) return;
  rvAddCtx = { from: p.from || "", ko: p.ko || "" };
  vaultMode = "due"; go("vault");
  const box = $("#rvAddBox"), inp = $("#rvAddIn"); if (!box || !inp) return;
  box.open = true; inp.value = p.text;
  if (p.from === "news") toast("데일리 브리프에서 보낸 문장이에요. 검토할게요");
  box.scrollIntoView({ block: "start" });
  $("#rvAddGo").click();
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
// ── 복습 엔진: 약점 우선 + 잘 아는 문장은 간격을 늘림 + 하루 상한 ──
const REVIEW_DAILY_CAP = 20;
/** 문장별 기록(예전 문장은 단계·횟수로 추정): 시도·정답·오답·연속 정답 */
function rvStats(w) {
  const reps = w.reps || 0;
  const okc = w.okc ?? Math.min(reps, w.box || 0);
  const miss = w.miss ?? Math.max(w.manual ? 0 : 1, reps - okc + (w.manual ? 0 : 1));
  return { reps, okc, miss, streak: w.streak ?? (w.box || 0), acc: reps ? Math.round((okc / reps) * 100) : null };
}
/** 오늘 복습 순서 점수: 자주 틀린 문장 → 아직 한 번도 복습 안 한 문장 → 오래 안 본 문장 */
function rvPriority(w) {
  const st = rvStats(w), overdue = Math.max(0, dayNum(today()) - dayNum(w.due || today()));
  const oftenWrong = st.miss >= 2 && st.miss > st.okc;
  return (oftenWrong ? 100 : 0) + (st.reps === 0 ? 60 : 0) + Math.min(overdue, 30) + st.miss * 3 - st.okc - st.streak * 2 + (w.lastOk === false ? 10 : 0);
}
const allDue = () => S.wrong.filter((w) => !w.del && !w.mastered && w.due <= today()).sort((a, b) => rvPriority(b) - rvPriority(a));
const reviewLeftToday = () => Math.max(0, REVIEW_DAILY_CAP - (todayH().review || 0));
/** 오늘 복습할 문장(우선순위 순, 하루 상한까지). 밀린 건 내일로 */
const dueItems = () => allDue().slice(0, reviewLeftToday());

function addWrong(it, mine, res) {
  const key = norm(it.en);
  let w = S.wrong.find((x) => norm(x.en) === key);
  const now = new Date().toISOString();
  if (!w) { w = { id: uid(), ko: it.ko, en: it.en, src: it.src || "", reps: 0, at: now }; S.wrong.unshift(w); }
  Object.assign(w, { mine, why: res?.why || "", natural: res?.natural || "", types: Array.isArray(res?.types) ? res.types : (w.types || []), box: 0, due: addDays(today(), 1), upd: now });
  save();
}
/** 따라 말하기·발음 연습에서 80% 미만이면 복습함에 저장. 같은 화면에서 다시 해서 통과하면 방금 새로 넣은 문장은 뺌(원래 있던 복습 문장은 그대로) */
const shadowAdded = new Map();
function shadowResult(it, r, src) {
  const key = norm(it.en); if (!key || !r) return;
  if (r.score >= 80) {
    const id = shadowAdded.get(key); if (!id) return;
    const w = S.wrong.find((x) => x.id === id); if (w && !(w.reps > 0)) { S.wrong = S.wrong.filter((x) => x.id !== id); save(); }
    shadowAdded.delete(key); return;
  }
  const existed = S.wrong.some((x) => !x.del && norm(x.en) === key);
  addWrong({ ko: it.ko || "", en: it.en, src }, r.text || "", { why: `따라 말하기 ${r.score}%${r.missed && r.missed.length ? ` — 놓친 단어: ${r.missed.slice(0, 5).join(", ")}` : ""}`, types: [] });
  if (!existed) { const w = S.wrong.find((x) => norm(x.en) === key); if (w) shadowAdded.set(key, w.id); }
}
/** 직접 넣은 영어 문장을 복습 목록에 추가(이미 있으면 기록은 두고 뜻·해설만 갱신) */
function addManualReview(it, useNatural) {
  const en = String(useNatural ? it.natural : it.en).trim(), key = norm(en);
  if (!key) return false;
  const now = new Date().toISOString();
  let w = S.wrong.find((x) => !x.del && norm(x.en) === key);
  const ko = useNatural && it.naturalKo ? it.naturalKo : it.ko;
  if (w) { Object.assign(w, { ko: ko || w.ko, upd: now }); save(); return "dup"; }
  w = { id: uid(), ko, en, src: rvAddCtx?.from === "news" ? "뉴스에서" : "직접 추가", reps: 0, okc: 0, miss: 0, streak: 0, manual: true, at: now, upd: now, box: 0, due: today(),
    mine: useNatural && norm(it.en) !== key ? it.en : "", why: it.why || "", natural: it.natural || "", types: Array.isArray(it.types) ? it.types : [] };
  S.wrong.unshift(w); save(); return true;
}
async function reviewAddCheck(v) {
  const lines = $("#rvAddIn").value.split(/\n+/).map((x) => x.trim()).filter((x) => /[A-Za-z]/.test(x));
  const msg = $("#rvAddMsg"), out = $("#rvAddOut"), btn = $("#rvAddGo");
  if (!lines.length) return toast("영어 문장을 한 줄에 하나씩 넣어 주세요");
  if (lines.length > 10) toast("한 번에 10문장까지만 검토해요. 앞의 10문장만 볼게요");
  const pick = lines.slice(0, 10);
  btn.disabled = true; msg.innerHTML = `<span class="spinner"></span> ${pick.length}문장 검토 중…`; out.innerHTML = "";
  try {
    const fromNews = rvAddCtx?.from === "news";
    const r = await ai("review_add", { text: pick.map((x, i) => `${i + 1}. ${x}`).join("\n"), ...(fromNews ? { ctx: "news", hint: rvAddCtx.ko || "" } : {}) });
    const items = (r.items || []).filter((x) => x && x.en && x.ko).slice(0, pick.length);
    if (!items.length) throw new Error("검토 결과가 비었어요. 다시 눌러 주세요");
    msg.textContent = `${items.length}문장 검토 완료`;
    renderReviewAdd(v, items);
  } catch (e) { msg.textContent = ""; toast(e.message); }
  finally { btn.disabled = false; }
}
function renderReviewAdd(v, items) {
  const out = $("#rvAddOut");
  const same = (it) => norm(it.natural) === norm(it.en);
  // 문법이 틀리면 고친 문장이 기본, 문법은 맞는데 어색하면(6점 이하) 고친 문장 추천, 아니면 내 문장 그대로
  const news = rvAddCtx?.from === "news";   // 뉴스 제목은 말할 때 쓰는 문장으로 바꾼 쪽이 기본
  const pref = (it) => (!same(it) && (news || it.grammar === false || (+it.score || 10) <= 6) ? "fix" : "mine");
  out.innerHTML = items.map((it, i) => {
    const sc = Math.max(1, Math.min(10, Math.round(+it.score || 0))) || null, p = pref(it), isSame = same(it);
    return `<div class="item rvadd" data-i="${i}">
      <div class="en">${esc(it.en)}</div><div class="ko">${esc(it.ko)}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin:6px 0">
        <span class="rvtag ${it.grammar === false ? "bad" : "good"}">${it.grammar === false ? "문법 ✗" : "문법 ✓"}</span>
        ${sc ? `<span class="rvtag ${sc >= 8 ? "good" : sc >= 6 ? "new" : "bad"}">자연스러움 ${sc}/10</span>` : ""}</div>
      ${it.grammar === false && it.grammarNote ? `<div class="small">📝 ${esc(it.grammarNote)}</div>` : ""}
      ${!isSame ? `<div class="keybox"><b>${news ? "말로 하면" : "원어민이라면"}</b> ${esc(it.natural)} ${sayBtns(it.natural)}${it.naturalKo ? `<div class="small muted">${esc(it.naturalKo)}</div>` : ""}</div>` : ""}
      ${it.why ? `<div class="small muted">${esc(it.why)}</div>` : ""}
      <div class="acts" data-acts="${i}">${isSame ? `<button class="btn sm primary" data-add="mine">복습에 추가</button>`
        : `<button class="btn sm ${p === "mine" ? "primary" : ""}" data-add="mine">${news ? "제목 그대로 추가" : "내 문장 그대로 추가"}</button><button class="btn sm ${p === "fix" ? "primary" : ""}" data-add="fix">${news ? "말하는 문장으로 추가" : "고친 문장으로 추가"}${p === "fix" ? " (추천)" : ""}</button>`}</div></div>`;
  }).join("") + (items.length > 1 ? `<button class="btn primary big" id="rvAddAll" style="margin-top:8px">추천대로 모두 추가 (${items.length})</button>` : "");
  const done = (i, res, useFix) => {
    const box = out.querySelector(`[data-acts="${i}"]`); if (!box) return;
    box.innerHTML = `<span class="small" style="color:var(--good)">${res === "dup" ? "이미 복습 목록에 있어요 (뜻만 갱신)" : `✓ ${useFix ? "고친 문장" : "내 문장"}으로 추가됨 · 오늘 복습에 나와요`}</span>`;
    box.dataset.done = "1";
  };
  out.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => {
    const i = +b.closest("[data-i]").dataset.i, fix = b.dataset.add === "fix";
    done(i, addManualReview(items[i], fix), fix); afterAdd();
  }));
  const afterAdd = () => { if ([...out.querySelectorAll("[data-acts]")].every((x) => x.dataset.done)) { $("#rvAddIn").value = ""; rvAddCtx = null; const a = $("#rvAddAll"); if (a) a.remove(); toast("복습 목록에 추가했어요"); setTimeout(() => renderVault(v), 1200); } };
  if ($("#rvAddAll")) $("#rvAddAll").onclick = () => { items.forEach((it, i) => { if (!out.querySelector(`[data-acts="${i}"]`)?.dataset.done) { const fix = pref(it) === "fix"; done(i, addManualReview(it, fix), fix); } }); afterAdd(); };
}
function reviewResult(w, ok) {
  const st = rvStats(w);   // 예전 문장은 여기서 처음으로 실제 기록 필드를 갖게 된다
  w.reps = st.reps + 1; w.okc = st.okc + (ok ? 1 : 0); w.miss = st.miss + (ok ? 0 : 1);
  w.streak = ok ? st.streak + 1 : 0; w.lastOk = ok; w.last = today();
  w.box = ok ? Math.min((w.box || 0) + 1, SRS.length) : 0;
  w.upd = new Date().toISOString();
  if (ok) { const n = norm(w.en); for (const [id, e] of Object.entries(S.expr)) if (id && n.includes(id) && !e.passed) e.passed = today(); log("review_ok"); }
  if (ok && w.box >= SRS.length) { w.mastered = true; w.due = "9999-12-31"; log("mastered"); }
  else {
    // 연속으로 맞출수록 다음 간격을 늘림(3번 연속 정답이면 2배, 최대 120일), 틀리면 처음(내일)부터
    const base = ok ? SRS[w.box - 1] || 1 : 1;
    w.due = addDays(today(), ok && w.streak >= 3 ? Math.min(base * 2, 120) : base);
  }
  save();
}
function saveSentence(x) {
  const key = norm(x.en);
  if (S.saved.some((s) => norm(s.en) === key)) { toast("이미 저장된 문장이에요"); return false; }
  S.saved.unshift({ id: uid(), en: x.en, ko: x.ko || "", key: x.key || "", keyKo: x.keyKo || "", src: x.src || "", at: new Date().toISOString() });
  if (x.key) exprMark(x.key, x.keyKo, "seen");
  save(); toast("저장했어요 ☆"); return true;
}
const isSaved = (en) => S.saved.some((s) => norm(s.en) === norm(en));

// ── YouGlish · 표현 마스터 · 말하기 기록 · 약점 ───────────────
// YouGlish 검색어: 주어·조동사를 떼고 핵심만 (최대 4단어) — 예) "I'm ringing about" → "ringing about"
function ygPhrase(k) {
  let t = String(k || "").toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) {
    const m = t.replace(/^(i|you|we|they|he|she|it|that|there|let's)(?:'(?:m|re|ve|d|ll|s))?\s+/, "").replace(/^(am|are|is|was|were|do|does|did|will|would|could|can|should)\s+/, "");
    if (m && m.split(" ").length >= 2) t = m; else break;
  }
  const w = t.split(" ").filter(Boolean);
  return (w.length > 4 ? w.slice(0, 4) : w).join(" ");
}
function ygUrl(k) {
  const p = ygPhrase(k); if (!p) return "";
  const acc = { "en-US": "us", "en-GB": "uk", "en-AU": "aus" }[S.settings.accent];   // 뉴질랜드는 억양 지정 없이 전체 검색
  return "https://youglish.com/pronounce/" + encodeURIComponent(p) + "/english" + (acc ? "/" + acc : "");
}
const ygBtn = (k) => (ygUrl(k) ? `<a class="act yg" href="${ygUrl(k)}" target="_blank" rel="noopener">▶ 실제 예문</a>` : "");
const exprId = (k) => norm(ygPhrase(k) || k);
const STAGES = [["seen", "저장"], ["dict", "받아쓰기"], ["spoken", "따라 말함"], ["used", "영작 사용"], ["passed", "복습 통과"]];
function exprMark(key, ko, stage) {
  const id = exprId(key); if (!id) return;
  const e = S.expr[id] || (S.expr[id] = { k: key, ko: ko || "" });
  if (ko && !e.ko) e.ko = ko;
  if (!e[stage]) { e[stage] = today(); save(); }
}
function markUsed(mine) {
  const n = norm(mine); let ch = false;
  for (const [id, e] of Object.entries(S.expr)) if (id && n.includes(id) && !e.used) { e.used = today(); ch = true; }
  if (ch) save();
}
const exprDone = (e) => STAGES.filter(([k]) => e[k]).length;
function recordSpeak(sc, i, score) {
  const key = sc.id + ":" + i, c = S.speak[key];
  const rec = { sc: sc.id, t: sc.title, i, en: sc.lines[i].en, first: c ? c.first : score, last: score, best: Math.max(c ? c.best : 0, score), n: (c ? c.n : 0) + 1, at: new Date().toISOString() };
  S.speak[key] = rec; save(); return rec;
}
const ERR_TYPES = ["관사", "시제", "전치사", "어순", "어휘 선택", "수 일치", "구어체 표현", "기타"];
function recordErrors(types) {
  for (const t of types.slice(0, 3)) S.errors.unshift({ id: uid(), at: new Date().toISOString(), d: today(), t: ERR_TYPES.includes(t) ? t : "기타" });
  S.errors = S.errors.slice(0, 300);
}

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
// ── AI 호출: 같은 질문은 기기에 저장해 둔 답을 바로 쓰고(한도 절약), 연결이 끊기거나 서버가 잠깐 바쁘면 자동으로 다시 시도 ──
const AI_CACHE_TASKS = new Set(["naturalize", "correct", "review_add"]);   // 같은 입력이면 같은 답이 맞는 작업만(새로 만들기 작업은 제외, 단어 풀이는 따로 저장)
const AI_CACHE_MAX = 300, AI_CACHE_DAYS = 60;
const hashStr = (str) => { let h1 = 5381, h2 = 52711; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; } return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36); };
const aiCacheKey = (task, payload) => "et:aic:" + hashStr(task + "|" + JSON.stringify(payload, Object.keys(payload).sort()));
function aiCacheGet(k) {
  try { const x = JSON.parse(lsGet(k) || "null"); if (x && x.t > Date.now() - AI_CACHE_DAYS * 864e5) return x.r; } catch {}
  return null;
}
function aiCachePut(k, r) {
  lsSet(k, JSON.stringify({ t: Date.now(), r }));
  let idx = []; try { idx = JSON.parse(lsGet("et:aic:idx") || "[]"); } catch {}
  idx = [...idx.filter((x) => x !== k), k];
  while (idx.length > AI_CACHE_MAX) { const old = idx.shift(); try { localStorage.removeItem(old); } catch {} }
  lsSet("et:aic:idx", JSON.stringify(idx));
}
function waitOnline(maxMs = 30000) {
  if (navigator.onLine !== false) return Promise.resolve(true);
  toast("인터넷이 끊겼어요. 연결되면 자동으로 다시 시도할게요", 3500);
  return new Promise((res) => { const t = setTimeout(() => { removeEventListener("online", on); res(false); }, maxMs); const on = () => { clearTimeout(t); res(true); }; addEventListener("online", on, { once: true }); });
}
async function ai(task, payload, opt = {}) {
  const useCache = AI_CACHE_TASKS.has(task) && !opt.fresh && payload.engine !== "best";
  const ck = useCache ? aiCacheKey(task, payload) : "";
  if (ck) { const hit = aiCacheGet(ck); if (hit) return hit; }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await waitOnline())) throw new Error("인터넷 연결이 없어요. 연결된 뒤 다시 눌러 주세요");
    let r;
    try { r = await api("/api/ai", { method: "POST", body: JSON.stringify({ task, ...payload }) }); }
    catch (e) { lastErr = new Error("연결이 불안정해요. 다시 시도 중…"); await sleep(1000 * (attempt + 1) * 1.5); continue; }   // 네트워크 끊김
    if (r.ok && r.data.result) { if (ck) aiCachePut(ck, r.data.result); return r.data.result; }
    lastErr = new Error(r.data.error || "AI를 쓸 수 없어요");
    if (r.status === 429 || (r.status >= 400 && r.status < 500)) break;   // 한도·잘못된 요청은 다시 해도 같음
    if (attempt < 2) { if (attempt === 0) toast("AI가 잠깐 바빠요. 자동으로 다시 시도할게요"); await sleep(1500 * (attempt + 1)); }
  }
  throw lastErr;
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
  const simple = /^[a-z' -]{1,40}$/i.test(word);
  const key = word.toLowerCase();
  out.innerHTML = `<div class="card"><span class="spinner"></span> 찾는 중…</div>`;
  const cached = wordCache.get(key);
  const dictP = cached ? Promise.resolve(cached.d) : simple ? api("/api/dict?w=" + encodeURIComponent(key)).then((r) => r.data || {}).catch(() => ({})) : Promise.resolve({});
  const aiP = cached?.x ? Promise.resolve(cached.x) : ai("word", { word }).catch((e) => ({ _err: e.message }));
  const bestP = cached?.x?._best ? null : ai("word", { word, engine: "best" }).catch(() => null);   // 정밀 풀이(느림) — 오면 교체
  const draw = (d, x, pending) => {
    const ok = x && !x._err;
    if (!ok && !(d.defs || []).length && !pending) { out.innerHTML = `<div class="card empty">찾지 못했어요. ${x?._err ? esc(x._err) : ""}</div>`; return; }
    const au = d.audio || {};
    const audioBtn = (reg, label, lang) => au[reg] ? `<button class="btn sm" data-audio="${esc(au[reg])}">🔊 ${label} 원어민</button>` : `<button class="btn sm" data-say="${esc(word)}" data-lang="${lang}">🔊 ${label}</button>`;
    out.innerHTML = `<div class="card">
    <div class="row spread"><h2>${esc(ok ? x.word || word : word)}</h2><span class="row" style="gap:4px"><span class="tag">${esc((ok && x.pos) || d.defs?.[0]?.pos || "")}</span>${ok && x.register ? `<span class="tag">${esc(x.register)}</span>` : ""}${ok && x.region ? `<span class="tag" style="background:var(--b-bubble)">${esc(x.region)}</span>` : ""}</span></div>
    <div class="row wrap" style="margin:6px 0 10px;gap:12px">
      <span><span class="small muted">US</span> <span class="ipa">${esc((ok && x.ipaUS) || d.phon?.us || "")}</span></span>
      <span><span class="small muted">UK</span> <span class="ipa">${esc((ok && x.ipaUK) || d.phon?.uk || "")}</span></span></div>
    <div class="row wrap">${audioBtn("us", "미국", "en-US")}${audioBtn("uk", "영국", "en-GB")}${au.au ? audioBtn("au", "호주", "en-AU") : ""}${ygBtn(word)}</div>
    ${ok ? `<p style="font-size:17px;font-weight:700;margin:12px 0 4px">${esc(x.ko)}</p><p class="small muted" style="margin:0">${esc(x.nuance || "")}</p>` : ""}
    ${!ok ? ((d.defs || []).map((f) => `<p class="small"><b>${esc(f.pos)}</b> ${esc(f.def)}</p>`).join("") + (pending ? `<p class="small muted"><span class="spinner"></span> 한국어 뜻·예문 만드는 중…</p>` : `<p class="small muted">AI 설명을 불러오지 못해 영영 풀이만 보여 드려요. (${esc(x?._err || "")})</p>`)) : ""}
    ${ok && x.similar?.length ? `<div class="label" style="margin-top:12px">비슷한 표현</div>${x.similar.map((m) => `<div class="small"><b class="w" data-w="${esc(m.w)}" style="cursor:pointer">${esc(m.w)}</b> — ${esc(m.d)}</div>`).join("")}` : ""}
    ${ok && x.collocations?.length ? `<div class="label" style="margin-top:12px">자주 같이 쓰는 말</div><div class="row wrap">${x.collocations.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>` : ""}
  </div>
  ${ok && x.examples?.length ? `<div class="card"><div class="label">예문</div>${x.examples.map((e) => `<div class="item"><div class="en">${tappable(e.en)}</div><div class="ko">${esc(e.ko)}</div><div class="acts">${sayBtns(e.en)}${starBtn({ en: e.en, ko: e.ko, key: word, src: "단어 " + word })}</div></div>`).join("")}</div>` : ""}
  ${ok && x.drill?.length ? `<div class="card"><div class="label">이 단어로 말해 보기</div><div id="wDrill"></div></div>` : ""}
  <button class="btn big" id="wSave">${S.words.some((w) => w.w === key) ? "★ 단어장에 있음" : "☆ 단어장에 저장"}</button>`;
    out.querySelectorAll("[data-audio]").forEach((b) => (b.onclick = () => new Audio(b.dataset.audio).play().catch(() => speak(word))));
    if (ok && x.drill?.length) quiz($("#wDrill"), x.drill.map((q) => ({ ...q, src: "단어 " + word })), { kind: "drill", compact: true });
    $("#wSave").onclick = () => {
      if (!S.words.some((v) => v.w === key)) { S.words.unshift({ id: "w:" + key, w: key, ko: (ok && x.ko) || d.defs?.[0]?.def || "", at: new Date().toISOString() }); log("words"); toast("단어장에 저장했어요"); }
      $("#wSave").textContent = "★ 단어장에 있음";
    };
  };
  // 사전(빠름)을 먼저 보여 주고, AI 설명이 오면 채운다
  const d = await dictP;
  if ((d.defs || []).length || (d.audio && (d.audio.us || d.audio.uk))) draw(d, null, true);
  let x = await aiP;
  if (x && !x._err) wordCache.set(key, { d, x });
  draw(d, x, false);
  if (bestP) {   // 정밀 풀이가 도착하면 더 정확한 내용으로 교체
    const bx = await bestP;
    if (bx && !bx._err && bx.ko && $("#wSave") && !$("#wDrill input, #wDrill textarea")?.value) {
      wordCache.set(key, { d, x: bx }); draw(d, bx, false);
      const t = document.createElement("div"); t.className = "small muted"; t.style.margin = "6px 2px"; t.textContent = "✓ 더 정확한 풀이로 업데이트했어요";
      out.prepend(t); setTimeout(() => t.remove(), 4000);
    }
  }
}
const wordCache = new Map();

async function convert(text, out) {
  if (!text) return;
  out.innerHTML = `<div class="card"><span class="spinner"></span> 바꾸는 중…</div>`;
  try {
    const x = await ai("naturalize", { text });
    const row = (label, en) => en ? `<div class="item"><div class="label">${label}</div><div class="en">${tappable(en, label === "가장 자연스럽게" ? x.key : "")}</div><div class="acts">${sayBtns(en)}${starBtn({ en, ko: x.ko || text, key: x.key, keyKo: x.keyKo, src: "변환" })}</div></div>` : "";
    out.innerHTML = `<div class="card">${row("가장 자연스럽게", x.best)}${row("더 캐주얼 (Kiwi)", x.casual)}${row("더 정중하게", x.polite)}
      ${x.key ? `<div class="keybox"><b>${esc(x.key)}</b> — ${esc(x.keyKo || "")} ${ygBtn(x.key)}</div>` : ""}
      ${(x.notes || []).length ? `<ul class="small">${x.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}</div>`;
    log("convert");
  } catch (e) { out.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

// 깨진 AI 문장(낱자모 나열·같은 글자 반복·0/1 나열) 숨김
const looksBroken = (t) => typeof t === "string" && (((t.match(/[\u3131-\u318E\u1100-\u11FF]/g) || []).length >= 4) || /(.{1,6}?)\1{6,}/u.test(t) || /[01]{8,}/.test(t) || /[\uFFFD\u25A1\u25A0]/.test(t));

// ── 퀴즈(영작·드릴·복습 공통) ───────────────────────────
// items: [{ko, en, hint?, sp?, context?}] / opts.kind: write|drill|review / onDone()
function quiz(box, items, opts = {}) {
  let i = 0, results = [];
  const step = () => {
    if (i >= items.length) {
      const ok = results.filter(Boolean).length;
      if (opts.noSummary) { opts.onDone?.(ok, items.length); return; }
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
          try { r = await ai("correct", { ko: it.ko, answer: it.en, mine, target: opts.target || "", context: ctx ? items.slice(0, i).map((p) => `${p.sp || ""}: ${p.en}`).join("\n") : "" }); }
          catch (e) { r = { score: sim, ok: sim >= 80, corrected: mine, natural: it.en, why: `AI 확인을 못 해서 정답과 단어 일치율(${sim}%)로만 판단했어요. 맞다고 생각되면 '맞은 걸로'를 눌러요.`, offline: true }; }
        }
      } else r = { score: 0, ok: false, corrected: "", natural: it.en, why: "정답을 소리 내어 3번 따라 말해 보세요." };
      const ok = !!r.ok;
      res.innerHTML = `<div class="result ${ok ? "ok" : "no"}">
        <div class="row spread"><span class="score">${ok ? "👍" : "✍️"} ${r.score ?? ""}</span><span class="tag ${ok ? "good" : "bad"}">${ok ? "통과" : "복습함에 저장"}</span></div>
        ${mine && r.corrected && norm(r.corrected) !== norm(mine) ? `<div class="pair"><small>교정</small>${esc(r.corrected)}</div>` : ""}
        <div class="pair"><small>원어민이라면</small><span class="en">${tappable(r.natural || it.en)}</span></div>
        ${norm(r.natural) !== norm(it.en) ? `<div class="pair"><small>모범 답안</small>${esc(it.en)}</div>` : ""}
        ${r.why && !looksBroken(r.why) ? `<p class="small" style="margin:8px 0 0">${esc(r.why)}</p>` : ""}
        ${(r.points || []).filter((p) => !looksBroken(p)).length ? `<ul>${r.points.filter((p) => !looksBroken(p)).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        <div class="acts">${sayBtns(r.natural || it.en)}${starBtn({ en: r.natural || it.en, ko: it.ko, src: opts.src || "" })}</div>
      </div>
      <div class="row" style="margin-top:10px">${!ok && r.offline ? `<button class="btn" id="qOk">맞은 걸로</button>` : ""}<button class="btn primary big" id="qNext">${i + 1 < items.length ? "다음 →" : opts.noSummary ? "다음 단계 →" : "결과 보기"}</button></div>`;
      let final = ok;
      const record = () => {
        if (opts.kind === "review") reviewResult(it._ref, final);
        else if (!final) addWrong({ ...it, src: opts.src || it.src }, mine, r);
        if (mine && final) markUsed(mine);
        if (r && Array.isArray(r.types) && r.types.length && (!final || (r.score ?? 100) < 90)) recordErrors(r.types);
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

// ── 독백 낭독 ───────────────────────────────────────────
// 1 낭독(듣기·같이 읽기·혼자 읽기, 노래방 하이라이트) 2 점점 지우기 3 녹음·원어민 비교(기기 저장)
// 4 받아쓰기 대조(Whisper) 5 내 이야기로 독백 만들기(AI) 6 매일 루틴·기록
const MONOS = window.MONOLOGUES || [];
const allMonos = () => [...S.monos.filter((m) => !m.del), ...MONOS];
const monoSaved = (m) => !!(m && (m.custom || S.done["mfav:" + m.id]));
const savedMonos = () => [...S.monos.filter((m) => !m.del), ...MONOS.filter((m) => S.done["mfav:" + m.id])];
function todayMono() {
  const pick = S.done["mpick:" + today()];
  return allMonos().find((m) => m.id === pick) || MONOS[dayNum(today()) % Math.max(1, MONOS.length)];
}
const monoText = (en) => String(en || "").replace(/\s*\/\s*/g, " ").trim();
const chunksOf = (en) => String(en || "").split(/\s*\/\s*/).map((c) => c.trim()).filter(Boolean);
const STOP = new Set("a an the and or but so to of in on at for with from by up out is am are was were be been it its it's i i'm i've i'd i'll me my we we're we've our you you're your he she they them their this that there these those just really very do did does don't didn't can can't will would could should have has had not no yes as if about like then than too also all some any".split(" "));
const MONO_ROUNDS = [["full", "1 전체"], ["key", "2 핵심 단어"], ["first", "3 첫 단어"], ["cue", "4 줄거리만"]];
// ④-4 줄거리만: 문장마다 영어 정답을 숨겨 두고 눌렀을 때만 보여 준다 (바꾸면 다시 가림)
let monoAns = new Set(), monoAnsKey = "";
const cueLineHtml = (m, li) => {
  const ln = m.lines[li], on = monoAns.has(li);
  return `<div class="ko mq"><b>${li + 1}.</b> ${esc(ln.ko)}</div>` + (on
    ? `<div class="mans"><p class="en">${chunksOf(ln.en).map((c) => wrapWords(c)).join('<i class="mslash">/</i>')}</p>
        ${ln.tip ? `<div class="tip">${esc(ln.tip)}</div>` : ""}
        <div class="acts macts">${sayBtns(monoText(ln.en))}${starBtn({ en: monoText(ln.en), ko: ln.ko, src: m.title })}<button type="button" class="act" data-ans="${li}">🙈 다시 가리기</button></div></div>`
    : `<button type="button" class="mans-btn" data-ans="${li}" aria-label="${li + 1}번 영어 정답 보기">👆 눌러서 영어 정답 보기</button>`);
};
let monoStep = "listen", monoRound = "full", monoRate = 1, monoKo = true, monoRun = null, monoLast = null;

// 점점 지우기: 단어를 밑줄 칸으로
function blankWord(w) { return `<span class="mblank" data-w="${esc(w)}" style="width:${Math.min(w.length, 9) * 0.62 + 0.4}em"></span>`; }
// 빈칸을 누르고 있는 동안만 그 단어를 보여 주고, 손을 떼면(또는 화면을 스크롤하면) 다시 가린다
const peekOff = () => document.querySelectorAll(".mblank.peek").forEach((b) => b.classList.remove("peek"));
document.addEventListener("pointerdown", (e) => { const b = e.target.closest?.(".mblank"); if (b) { peekOff(); b.classList.add("peek"); } });
["pointerup", "pointercancel", "dragstart", "scroll"].forEach((ev) => window.addEventListener(ev, peekOff, true));
document.addEventListener("contextmenu", (e) => { if (e.target.closest?.(".mblank")) e.preventDefault(); });   // 길게 누를 때 뜨는 메뉴 막기
function maskChunk(c, round) {
  if (round === "full") return wrapWords(c);
  const words = c.split(/\s+/);
  return words.map((w, i) => {
    const bare = norm(w);
    if (round === "key") return !bare || STOP.has(bare) || bare.length < 4 ? blankWord(w) : esc(w);
    return i === 0 ? esc(w) : blankWord(w);   // first
  }).join(" ");
}

// 문장 단위로 읽어 주면서 끊어 읽기 덩어리를 하이라이트 (boundary 이벤트가 없으면 시간으로 추정)
function speakChunks(en, rate, onChunk) {
  const parts = chunksOf(en), text = parts.join(" ");
  const starts = []; let pos = 0; for (const p of parts) { starts.push(pos); pos += p.length + 1; }
  return new Promise((res) => {
    if (!window.speechSynthesis) { toast("이 브라우저는 음성 재생을 지원하지 않아요"); return res(); }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = S.settings.accent; u.rate = (S.settings.rate || 0.95) * rate;
    const v = pickVoice(u.lang); if (v) u.voice = v;
    let got = false, cur = -1, timers = [];
    const set = (k) => { if (k !== cur) { cur = k; onChunk(k); } };
    u.onboundary = (e) => { got = true; timers.forEach(clearTimeout); let k = 0; while (k + 1 < starts.length && e.charIndex >= starts[k + 1]) k++; set(k); };
    u.onstart = () => {
      set(0);
      // 추정 타이밍(단어당 약 0.4초/속도) — boundary 가 오면 취소됨
      let t = 0;
      parts.forEach((p, k) => { if (k) timers.push(setTimeout(() => { if (!got) set(k); }, t)); t += (p.split(/\s+/).length * 400) / u.rate + 180; });
    };
    u.onend = u.onerror = () => { timers.forEach(clearTimeout); res(); };
    speechSynthesis.speak(u);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 녹음 (기기 안 IndexedDB 에만 저장) ──
const recDB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error("no idb"));
    const r = indexedDB.open("et-rec", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("recs", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("recs", mode), st = t.objectStore("recs"); const out = fn(st); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); };
  return {
    put: (rec) => tx("readwrite", (st) => st.put(rec)).catch(() => null),
    all: () => tx("readonly", (st) => st.getAll()).then((a) => (a || []).filter((x) => x.code === CODE)).catch(() => []),
    del: (id) => tx("readwrite", (st) => st.delete(id)).catch(() => null),
  };
})();
async function startRecorder() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("이 브라우저는 녹음을 지원하지 않아요 (Chrome·Safari 최신 버전 권장)");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { throw new Error("마이크 권한을 허용해 주세요"); }
  const rec = new MediaRecorder(stream), parts = [], t0 = Date.now();
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.start(250);
  return {
    stream,
    stop: () => new Promise((res) => {
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); res({ blob: new Blob(parts, { type: rec.mimeType || "audio/webm" }), dur: (Date.now() - t0) / 1000 }); };
      if (rec.state !== "inactive") rec.stop(); else rec.onstop();
    }),
  };
}
// 받아쓰기용: 16kHz 모노 WAV 로 변환
async function toWav16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext; const ac = new AC();
  const ab = await blob.arrayBuffer();
  const buf = await new Promise((res, rej) => { const p = ac.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
  ac.close?.();
  const len = Math.ceil(buf.duration * 16000), off = new OfflineAudioContext(1, len, 16000), src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2)), ws = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); ws(8, "WAVE"); ws(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); ws(36, "data"); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) { const v = Math.max(-1, Math.min(1, pcm[i])); out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
  return new Blob([out], { type: "audio/wav" });
}
async function transcribe(blob, kind = "") {
  const wav = await toWav16k(blob);
  const r = await fetch("/api/stt", { method: "POST", headers: { "content-type": "audio/wav", "x-code": CODE, ...(kind ? { "x-kind": kind } : {}) }, body: wav });
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(d.error || "받아쓰기 실패"); e.status = r.status; throw e; }
  return d;
}

// ── 따라 말하기 채점: 녹음 → Whisper 받아쓰기 → 단어별 대조. 안 되면 브라우저 음성 인식으로 ──
let sttOffToday = "";   // 한도 초과 등으로 오늘은 브라우저 인식만 쓰는 날
/** 말이 끝나고 조용해지면(1.2초) 자동으로 녹음을 멈춘다. 끝 버튼으로도 멈춤 */
function autoStop(rec, out, maxMs) {
  return new Promise((resolve) => {
    let done = false, ac, timer, iv;
    const finish = (heard) => { if (done) return; done = true; clearTimeout(timer); clearInterval(iv); try { ac && ac.close(); } catch {} resolve(heard); };
    let spoke = false, quietSince = 0, floor = 0, n = 0;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; ac = new AC();
      const an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(rec.stream).connect(an);
      const buf = new Float32Array(an.fftSize), t0 = Date.now();
      iv = setInterval(() => {
        an.getFloatTimeDomainData(buf); let sum = 0; for (const x of buf) sum += x * x; const rms = Math.sqrt(sum / buf.length);
        if (Date.now() - t0 < 300) { floor = (floor * n + rms) / ++n; return; }   // 처음 0.3초로 주변 소음 크기 측정
        const loud = rms > Math.max(0.015, floor * 3);
        if (loud) { spoke = true; quietSince = 0; } else if (spoke) { quietSince = quietSince || Date.now(); if (Date.now() - quietSince > 1200) finish(true); }
        if (!spoke && Date.now() - t0 > 6000) finish(false);   // 6초 동안 말이 없으면 끝
      }, 100);
    } catch { spoke = true; }   // 소리 크기를 못 재는 기기는 시간·버튼으로만
    timer = setTimeout(() => finish(true), maxMs);
    out.innerHTML = `<span class="recdot"></span> 듣는 중… 말을 마치면 자동으로 끝나요 <button class="act" data-recstop>■ 끝</button>`;
    out.querySelector("[data-recstop]").onclick = () => finish(true);
  });
}
/** 목표 문장 단어마다 맞음/빠짐 표시 */
function wordDiff(target, heard) {
  const words = String(target).split(/\s+/).filter(Boolean);
  const ref = []; words.forEach((w, wi) => toks(w).forEach((t) => ref.push({ wi, t })));
  const hyp = toks(heard), R = ref.length, H = hyp.length;
  const m = Array.from({ length: R + 1 }, () => new Array(H + 1).fill(0));
  for (let i = 1; i <= R; i++) for (let j = 1; j <= H; j++) m[i][j] = editOk(ref[i - 1].t, hyp[j - 1]) ? m[i - 1][j - 1] + 1 : Math.max(m[i - 1][j], m[i][j - 1]);
  const ok = new Set(); for (let i = R, j = H; i && j;) { if (editOk(ref[i - 1].t, hyp[j - 1]) && m[i][j] === m[i - 1][j - 1] + 1) { ok.add(i - 1); i--; j--; } else if (m[i - 1][j] >= m[i][j - 1]) i--; else j--; }
  const wordOk = words.map((_, wi) => ref.filter((r) => r.wi === wi).every((r) => ok.has(ref.indexOf(r))));
  const score = R ? Math.round((m[R][H] / Math.max(R, H)) * 100) : 0;
  const html = words.map((w, wi) => `<span class="${wordOk[wi] ? "dw-ok" : "dw-miss"}">${esc(w)}</span>`).join(" ");
  return { score, html, missed: words.filter((_, wi) => !wordOk[wi]).map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'’]+$/g, "")).filter(Boolean) };
}
/** 한 문장 듣고 채점: { score, text, html, via } (소리가 없으면 null) */
async function hearSentence(target, out) {
  const canRec = navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
  if (S.settings.stt !== "browser" && sttOffToday !== today() && canRec) {
    let rec;
    try { rec = await startRecorder(); } catch (e) { out.textContent = e.message; return null; }
    const maxMs = Math.min(20000, 4000 + toks(target).length * 700);
    const heard = await autoStop(rec, out, maxMs);
    const { blob } = await rec.stop();
    if (!heard) { out.textContent = "소리가 안 들렸어요. 다시 눌러 주세요."; return null; }
    out.innerHTML = '<span class="spinner"></span> AI가 받아쓰는 중…';
    try {
      const d = await transcribe(blob, "shadow");
      if (!d.text) { out.textContent = "말소리를 알아듣지 못했어요. 조금 더 크게 다시 해 보세요."; return null; }
      return { ...wordDiff(target, d.text), text: d.text, via: "AI" };
    } catch (e) {
      if (e.status === 429) { sttOffToday = today(); toast("오늘 AI 채점 한도를 다 써서 브라우저 인식으로 바꿀게요. 한 번 더 말해 주세요", 3500); }
      else toast("AI 받아쓰기가 안 돼서 브라우저 인식으로 들을게요. 한 번 더 말해 주세요", 3000);
    }
  }
  out.innerHTML = '<span class="spinner"></span> 말해 보세요…';
  const alts = await listen();
  if (!alts.length) { out.textContent = "소리가 안 들렸어요. 다시 눌러 주세요."; return null; }
  const best = alts.map((a) => ({ a, d: wordDiff(target, a) })).sort((x, y) => y.d.score - x.d.score)[0];
  return { ...best.d, text: best.a, via: "브라우저" };
}
/** 정답 없이 듣기(역할극): 녹음 → Whisper, 안 되면 브라우저 인식. 들린 글자를 돌려줌(없으면 "") */
async function hearFree(out) {
  const canRec = navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
  if (S.settings.stt !== "browser" && sttOffToday !== today() && canRec) {
    let rec;
    try { rec = await startRecorder(); } catch (e) { out.textContent = e.message; return ""; }
    const heard = await autoStop(rec, out, 20000);
    const { blob } = await rec.stop();
    if (!heard) { out.textContent = "소리가 안 들렸어요. 다시 눌러 주세요."; return ""; }
    out.innerHTML = '<span class="spinner"></span> 받아쓰는 중…';
    try { const d = await transcribe(blob, "shadow"); if (d.text) return d.text; out.textContent = "말소리를 알아듣지 못했어요. 다시 해 보세요."; return ""; }
    catch (e) { if (e.status === 429) sttOffToday = today(); toast("AI 받아쓰기가 안 돼서 브라우저 인식으로 들을게요. 한 번 더 말해 주세요", 3000); }
  }
  out.innerHTML = '<span class="spinner"></span> 말해 보세요…';
  const alts = await listen().catch((e) => { out.textContent = e.message; return []; });
  if (!alts.length && !out.textContent) out.textContent = "소리가 안 들렸어요. 다시 눌러 주세요.";
  return alts[0] || "";
}

// ── 🎭 AI 역할극: AI가 B 역할, 내가 A. 말하면 받아 적고 → 내 문장 교정 + B가 대답(음성). 끝나면 고친 문장을 복습에 ──
const RP_MAX_TURNS = 7;
function startRoleplay(sc, custom) {
  const scenario = custom || `${sc.title}${sc.setting ? " — " + sc.setting : ""}`;
  const roles = custom ? "A = me (the learner, a Korean parent living in Auckland), B = the other person in this situation" : `A = ${sc.roles?.A || "me"}, B = ${sc.roles?.B || "the other person"}`;
  const rp = { scenario, roles, lines: [], turns: 0, done: false, busy: false, targets: curRoleTargets(), used: {} };
  openSheet(`<h2>🎭 AI 역할극</h2><p class="small muted" style="margin:2px 0 8px">${esc(scenario)}<br>AI가 상대(B), 내가 A예요. 🎙를 누르고 말하면 받아 적어 대답해요. 막히면 🆘 모범답안을 보거나, ✍ 로 <b>한국어로 쓰면 영어로</b> 바꿔 줘요.</p>
    ${rp.targets.length ? `<div class="rp-targets" id="rpTargets"></div>` : ""}
    <div id="rpLog" class="rplog"></div>
    <div id="rpOut" class="small muted" style="min-height:22px;margin:6px 0"></div>
    <div class="row" style="gap:6px"><button class="btn primary big" id="rpMic" style="flex:1">🎙 말하기</button><button class="btn" id="rpType" aria-label="글로 쓰기 (한국어도 가능)">✍ 글로</button><button class="btn" id="rpEnd">끝내기</button></div>
    <div id="rpTypeBox" hidden style="margin-top:6px"><div class="row" style="gap:6px"><input class="text" id="rpIn" placeholder="영어로, 또는 한국어로 쓰세요" style="flex:1"><button class="btn primary" id="rpSend">보내기</button></div>
      <div class="small muted" id="rpKoHint" style="margin-top:4px">🇰🇷 영어가 안 나오면 <b>한국어로 쓰세요</b>. 지금 상황에 맞는 영어로 바꿔 주고, 복습 문장에도 자동으로 저장해요.</div></div>`);
  const log = $("#rpLog"), out = $("#rpOut");
  const hist = () => rp.lines.map((l) => `${l.sp}: ${l.en}`).join("\n");
  // 🎯 커리큘럼 목표 표현: 상대 AI 가 자연스럽게 쓸 기회를 만들고, 내가 쓰면 ✓ (내 힘으로 쓴 훈련 표현은 복습 통과로)
  const drawTargets = () => { const el = $("#rpTargets"); if (!el) return;
    el.innerHTML = `<span class="small muted">🎯 이번 역할극에서 써 볼 표현 <small>(커리큘럼)</small></span>${rp.targets.map((x) => `<span class="rp-tg ${rp.used[x.id] ? "on" : ""}" title="${esc(x.k)}">${rp.used[x.id] ? "✓ " : ""}${esc(x.e)}<small>${esc(x.k)}</small></span>`).join("")}`; };
  drawTargets();
  const checkTargets = (line, assist) => {
    let hit = false;
    for (const x of rp.targets) if (!rp.used[x.id] && curUses(line, x.e)) { rp.used[x.id] = assist ? "assist" : "own"; hit = true; }
    if (hit) { drawTargets(); toast("🎯 목표 표현을 썼어요!"); }
  };
  // 내 문장 점검 결과: 문법이 틀리면 틀린 부분 → 고친 부분을 짚고, 통과여도 더 자연스러운 표현이 있으면 같이 보여 줌
  const fixHtml = (l) => {
    if (l.assist) return "";
    if (l.fixErr) return `<div class="small muted">⚠ 이 문장은 점검하지 못했어요 (${esc(l.fixErr)})</div>`;
    if (!l.fix) return `<div class="small muted"><span class="spinner"></span> 문법 점검 중…</div>`;
    const f = l.fix;
    if (f.ok) return `<div class="small" style="color:var(--good)">✓ 문법은 맞아요${f.score ? ` · 자연스러움 ${f.score}/10` : ""}${f.why ? " — " + esc(f.why) : ""}</div>${f.natural && norm(f.natural) !== norm(l.en) ? `<div class="small muted">더 자연스럽게: ${esc(f.natural)} ${sayBtns(f.natural)}</div>` : ""}`;
    return `<div class="keybox fixbox"><div class="small" style="color:var(--bad);font-weight:700">✗ 고칠 곳이 있어요</div>
      ${(f.errors || []).map((e) => `<div class="small"><span class="dw-miss">${esc(e.wrong)}</span> → <b style="color:var(--good)">${esc(e.right)}</b>${e.note ? ` <span class="muted">· ${esc(e.note)}</span>` : ""}</div>`).join("")}
      <div style="margin-top:4px"><b>이렇게 말하면</b> ${esc(f.better)} ${sayBtns(f.better)}</div>
      ${f.natural && norm(f.natural) !== norm(f.better) ? `<div class="small muted">원어민은 보통: ${esc(f.natural)} ${sayBtns(f.natural)}</div>` : ""}
      <div class="small muted">${esc(f.why || "")}</div></div>`;
  };
  const draw = () => {
    log.innerHTML = rp.lines.map((l, i) => l.sp === "B"
      ? `<div class="rpb"><div class="en">${tappable(l.en)}</div><div class="ko small muted">${esc(l.ko || "")}</div><div class="acts">${sayBtns(l.en)}${l.hint && i === rp.lines.length - 1 && !rp.done ? `<span class="small muted">💡 ${esc(l.hint)}…</span>` : ""}</div>${i === rp.lines.length - 1 && !rp.done ? helpHtml(l) : ""}</div>`
      : `<div class="rpa"><div class="en">${esc(l.en)}</div>${l.assist === "ko" ? `<div class="small muted">🇰🇷 “${esc(l.ko || "")}” → 영어로 바꿔 답했어요</div>` : l.assist ? `<div class="small muted">🆘 모범답안${l.assist === "said" ? "을 따라 말했어요" : "으로 답했어요"}</div>` : ""}${fixHtml(l)}</div>`).join("");
    log.scrollTop = log.scrollHeight;
  };
  // 🆘 막혔을 때: 모범답안 → 듣기 → (글자 가리고) 따라 말하기 → 이 답으로 이어가기
  const helpHtml = (l) => {
    if (rp.kt) return `<div class="rphelp kt"><div class="small muted">🇰🇷 “${esc(rp.kt.srcKo)}”<br>→ 이 상황에서는 이렇게 말해요 <span class="tag good">✓ 복습에 저장됨</span></div>
      <div class="en ${rp.hide ? "blurred" : ""}" id="rpModel">${tappable(rp.kt.en)}</div>
      <div class="ko small muted ${rp.hide ? "blurred" : ""}">${esc(rp.kt.back || "")}</div>
      ${rp.kt.why ? `<div class="small" style="margin-top:2px">💡 ${esc(rp.kt.why)}</div>` : ""}
      <div class="acts">${sayBtns(rp.kt.en)}<button class="act ${rp.hide ? "on" : ""}" data-help="hide">🙈 글자 가리기</button></div>
      ${rp.kt.alt ? `<div class="small muted" style="margin-top:4px">다른 표현: <span class="alt">${esc(rp.kt.alt)}</span> <button class="act" data-say="${esc(rp.kt.alt)}" data-lang="en-US">🔊</button> <button class="act" data-help="usealt">이걸로</button></div>` : ""}
      <div class="row" style="gap:6px;margin-top:6px"><button class="btn primary" data-help="shadow" style="flex:1">🎙 따라 말하기</button><button class="btn" data-help="use">이 답으로 이어가기 ›</button></div>
      <div id="rpHelpOut" class="small" style="margin-top:6px">${rp.helpRes || ""}</div></div>`;
    if (!l.model) return "";
    if (!rp.help) return `<div class="acts" style="margin-top:6px"><button class="act help-open" data-help="open">🆘 말이 안 나와요 · 모범답안 보기</button></div>`;
    return `<div class="rphelp"><div class="small muted">🆘 이렇게 말해 보세요 — 먼저 듣고, 따라 해 보세요</div>
      <div class="en ${rp.hide ? "blurred" : ""}" id="rpModel">${tappable(l.model)}</div>
      <div class="ko small muted ${rp.hide ? "blurred" : ""}">${esc(l.modelKo || "")}</div>
      <div class="acts">${sayBtns(l.model)}<button class="act ${rp.hide ? "on" : ""}" data-help="hide">🙈 글자 가리기</button></div>
      <div class="row" style="gap:6px;margin-top:6px"><button class="btn primary" data-help="shadow" style="flex:1">🎙 따라 말하기</button><button class="btn" data-help="use">이 답으로 이어가기 ›</button></div>
      <div id="rpHelpOut" class="small" style="margin-top:6px">${rp.helpRes || ""}</div></div>`;
  };
  const step = async (mine, assist, assistKo) => {
    if (rp.busy) return; rp.busy = true;
    $("#rpMic").disabled = true;
    rp.help = false; rp.hide = false; rp.helpRes = ""; rp.kt = null; rp.shadowed = false;
    if (mine) {
      const line = { sp: "A", en: mine, assist: assist || "", ko: assistKo || "" };
      rp.lines.push(line); rp.turns++; draw();
      if (!line.assist) {   // 모범답안·변환 문장은 이미 올바르니 점검 생략. 내가 직접 말한 문장만 엄격하게 점검(상대 대사와 동시에 진행)
        const chk = ai("rp_check", { scenario: rp.scenario, history: hist().split("\n").slice(0, -1).join("\n"), mine }, { fresh: true })
          .then((f) => {
            const errs = (Array.isArray(f.errors) ? f.errors : []).filter((e) => e && e.wrong && e.right && norm(e.wrong) !== norm(e.right));
            // 문법 오류가 하나라도 있으면 통과가 아님(모델이 grammar:true 라고 해도), 자연스러움이 7 이하여도 고칠 문장으로 취급
            const ok = errs.length === 0 && f.grammar !== false && !(Number(f.score) <= 7);
            line.fix = { ok, errors: errs, better: String(f.better || mine), betterKo: f.betterKo || "", natural: f.natural || "", score: Number(f.score) || 0, why: f.why || "", types: Array.isArray(f.types) ? f.types : [] };
            if (!ok) {
              recordErrors(line.fix.types.length ? line.fix.types : ["기타"]);
              const added = addManualReview({ en: line.fix.better, ko: line.fix.betterKo || "", natural: line.fix.better, why: line.fix.errors.map((e) => `${e.wrong} → ${e.right}`).join(", ") || line.fix.why, types: line.fix.types }, false);
              const w = S.wrong.find((x) => !x.del && norm(x.en) === norm(line.fix.better));
              if (w) { if (added === true) w.src = "역할극"; w.mine = w.mine || mine; save(); }
              line.saved = true;
            }
            save(); draw();
          })
          .catch((e) => { line.fixErr = e.message || "AI 오류"; draw(); });
        (rp.checks = rp.checks || []).push(chk);
      }
    }
    out.innerHTML = '<span class="spinner"></span> 상대가 생각 중…';
    try {
      if (mine) checkTargets(mine, !!assist);
      const left = rp.targets.filter((x) => !rp.used[x.id]).map((x) => x.e).join(" | ");
      const r = await ai("roleplay", { scenario: rp.scenario, roles: rp.roles, history: hist().split("\n").slice(0, mine ? -1 : undefined).join("\n"), mine: mine || "", targets: left }, { fresh: true });
      rp.lines.push({ sp: "B", en: r.reply, ko: r.ko, hint: r.hint, model: String(r.model || "").trim(), modelKo: r.modelKo || "" });
      rp.done = !!r.done || rp.turns >= RP_MAX_TURNS;
      draw(); out.textContent = "";
      await speak(r.reply, S.settings.accent === "en-US" ? "en-GB" : undefined);
      if (rp.done) finish();
    } catch (e) { out.textContent = e.message; if (mine) { rp.lines.pop(); rp.turns--; draw(); } }
    finally { rp.busy = false; if ($("#rpMic")) $("#rpMic").disabled = rp.done; }
  };
  const finish = async () => {
    rp.done = true; log_("roleplay");
    const tgUsed = rp.targets.filter((x) => rp.used[x.id]);
    for (const x of tgUsed) { const c = S.cur.items[x.id]; if (!c) continue; c.rp = today();
      if (rp.used[x.id] === "own" && c.st === "train" && (c.due || "") <= today()) curMark(x, true); }
    if (rp.targets.length) save();
    if ((rp.checks || []).length) { out.innerHTML = '<span class="spinner"></span> 마지막 문장까지 점검하는 중…'; await Promise.all(rp.checks); }
    const fixes = rp.lines.filter((l) => l.sp === "A" && l.fix && !l.fix.ok && l.fix.better);
    // 모범답안을 쓴 문장은 내 실력이 아니므로 '자연스러웠어요' 집계에서 빼고, 복습에는 따로 넣을 수 있게 함
    const helped = rp.lines.filter((l) => l.sp === "A" && (l.assist === "model" || l.assist === "said")), koN = rp.lines.filter((l) => l.sp === "A" && l.assist === "ko").length;
    const own = rp.lines.filter((l) => l.sp === "A" && !l.assist && !l.fixErr), ownFix = fixes.filter((l) => !l.assist);
    const unchecked = rp.lines.filter((l) => l.sp === "A" && l.fixErr).length;
    const nSave = ownFix.length + helped.length;
    out.innerHTML = `<div class="card tight"><b>역할극 끝 👏</b> ${own.length ? `내 힘으로 말한 ${own.length}문장 중 ${own.length - ownFix.length}문장이 자연스러웠어요.` : "이번엔 도움을 받아 말하며 연습했어요."}${helped.length && own.length ? ` <span class="small muted">모범답안 참고 ${helped.length}문장</span>` : ""}${unchecked ? `<div class="small muted" style="margin:4px 0">⚠ ${unchecked}문장은 AI 오류로 점검하지 못했어요.</div>` : ""}${rp.targets.length ? `<div class="small" style="margin:4px 0">🎯 목표 표현 ${tgUsed.length}/${rp.targets.length}개 사용${tgUsed.length ? `: ${tgUsed.map((x) => esc(x.e) + (rp.used[x.id] === "assist" ? "(도움)" : "")).join(", ")}` : " — 다음엔 하나씩 써 봐요"}</div>` : ""}${koN ? `<div class="small muted" style="margin:4px 0">🇰🇷 한국어로 말해 영어로 바꾼 ${koN}문장은 복습에 이미 저장했어요.</div>` : ""}${nSave ? `<div class="small" style="margin:4px 0">📥 ${ownFix.length ? `고친 문장 ${ownFix.length}개` : ""}${ownFix.length && helped.length ? " + " : ""}${helped.length ? `모범답안 ${helped.length}개` : ""}를 복습함에 저장했어요. 다음에 한국어를 보고 다시 말해 봐요.</div>` : ""}</div>`;
    $("#rpMic").disabled = true;
  };
  log.onclick = async (e) => {
    const b = e.target.closest("[data-help]"); if (!b || rp.busy || rp.done) return;
    const last0 = rp.lines[rp.lines.length - 1], k = b.dataset.help;
    if (!last0 || last0.sp !== "B" || (!last0.model && !rp.kt)) return;
    // 한국어로 바꾼 영어가 있으면 그것이, 없으면 AI 모범답안이 연습 대상
    const last = rp.kt ? { model: rp.kt.en, modelKo: rp.kt.srcKo } : last0;
    if (k === "open") { rp.help = true; draw(); speak(last.model); return; }
    if (k === "hide") { rp.hide = !rp.hide; draw(); return; }
    if (k === "usealt" && rp.kt) { if (rp.kt.rowId) { S.wrong = S.wrong.filter((w) => w.id !== rp.kt.rowId); }   // 고른 표현만 복습에 남김
      rp.kt.en = rp.kt.alt; rp.kt.alt = ""; rp.kt.back = ""; rp.helpRes = ""; rp.shadowed = false; saveKt(rp.kt); draw(); speak(rp.kt.en); return; }
    if (k === "use") {
      const said = rp.shadowed; rp.shadowed = false;
      if (!rp.kt) {   // 스스로 말하지 못하고 모범답안으로 답한 문장 → 복습함
        const added = addManualReview({ en: last.model, ko: last.modelKo || "", natural: last.model, why: "역할극에서 말하지 못해 모범답안으로 답한 문장", types: [] }, false);
        const w = S.wrong.find((x) => !x.del && norm(x.en) === norm(last.model)); if (w && added === true) { w.src = "역할극 모범답안"; save(); }
      }
      step(last.model, rp.kt ? "ko" : said ? "said" : "model", last.modelKo); return;
    }
    if (k === "shadow") {
      const o = $("#rpHelpOut"); if (!o) return;
      o.innerHTML = '<span class="spinner"></span> 말해 보세요…';
      try {
        const r = await hearSentence(last.model, o); if (!r) return;
        rp.helpRes = `<span class="tag ${r.score >= 80 ? "good" : "bad"}">${r.score}%</span> ${r.score >= 80 ? "잘했어요! 이제 ‘이 답으로 이어가기’를 눌러요." : "한 번 더 듣고 천천히 따라 해 보세요."}${hearHtml(r)}`;
        if (r.score >= 80) { rp.shadowed = true; log_("shadow"); }   // 이 함수 안의 log 는 대화창 요소라 전역 log_ 를 씀
        const o2 = $("#rpHelpOut"); if (o2) o2.innerHTML = rp.helpRes;
      } catch (err) { o.textContent = err.message; }
    }
  };
  $("#rpMic").onclick = async () => { if (rp.busy || rp.done) return; const t = await hearFree(out); if (t) { out.textContent = ""; step(t); } };
  $("#rpType").onclick = () => { $("#rpTypeBox").hidden = !$("#rpTypeBox").hidden; if (!$("#rpTypeBox").hidden) $("#rpIn").focus(); };
  // 🇰🇷 한국어로 쓰면: 지금 상황에 맞는 영어로 바꾸고 → 복습 문장으로 자동 저장 → 듣기·따라 말하기 → 이어가기
  const saveKt = (kt) => {
    const w = addManualReview({ en: kt.en, ko: kt.srcKo, natural: kt.en, why: kt.why || "역할극에서 한국어로 말하고 싶었던 문장", types: [] }, false);
    const row = S.wrong.find((x) => !x.del && norm(x.en) === norm(kt.en));
    if (row && w === true) { row.src = "역할극 한국어"; kt.rowId = row.id; save(); } else kt.rowId = "";
    return w;
  };
  const translateKo = async (ko) => {
    if (rp.busy) return; rp.busy = true;
    const last = rp.lines[rp.lines.length - 1];
    out.innerHTML = '<span class="spinner"></span> 지금 상황에 맞는 영어로 바꾸는 중…';
    try {
      const r = await ai("rp_translate", { scenario: rp.scenario, roles: rp.roles, history: hist(), ko }, { fresh: true });
      rp.kt = { en: String(r.en).trim(), back: r.back || "", alt: r.alt && /[A-Za-z]/.test(r.alt) && !/[가-힣]/.test(r.alt) ? String(r.alt).trim() : "", why: r.why || "", srcKo: ko };
      rp.help = true; rp.hide = false; rp.helpRes = ""; rp.shadowed = false;
      const saved = saveKt(rp.kt);
      draw(); out.textContent = saved === "dup" ? "이미 복습에 있는 문장이에요." : "";
      speak(rp.kt.en);
    } catch (e) { out.textContent = e.message; $("#rpIn").value = ko; }
    finally { rp.busy = false; }
  };
  const HANGUL = /[가-힣ㄱ-ㅎ]/;
  const isKo = (t) => { const h = (t.match(/[가-힣ㄱ-ㅎ]/g) || []).length, e = (t.match(/[A-Za-z]/g) || []).length; return h >= 2 || (h >= 1 && h >= e); };
  const sendText = () => {
    const t = $("#rpIn").value.trim(); if (!t || rp.busy || rp.done) return;
    const last = rp.lines[rp.lines.length - 1];
    $("#rpIn").value = "";
    if (isKo(t)) { if (last && last.sp === "B") translateKo(t.slice(0, 300)); else out.textContent = "상대가 말한 뒤에 쓸 수 있어요."; return; }
    step(t);
  };
  $("#rpSend").onclick = sendText;
  $("#rpIn").oninput = () => { $("#rpSend").textContent = isKo($("#rpIn").value) ? "영어로 바꾸기" : "보내기"; };
  $("#rpIn").onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) $("#rpSend").click(); };
  $("#rpEnd").onclick = () => { if (rp.turns && !rp.done) finish(); else closeSheet(); };
  step("");
}
const log_ = (k) => log(k);

const hearHtml = (r) => `<div class="dwords">${r.html}</div><div class="small muted">들린 말(${r.via}): “${esc(r.text)}”${r.missed.length ? ` · 다시 들어 볼 단어: <b>${r.missed.slice(0, 4).map(esc).join(", ")}</b>` : ""}</div>`;

// ── 원문 대조: 단어 정렬(LCS) ──
const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function numWords(n) {
  n = +n; if (!(n >= 0 && n < 1000)) return [String(n)];
  if (n < 20) return [ONES[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]];
  return [ONES[Math.floor(n / 100)], "hundred", ...(n % 100 ? numWords(n % 100) : [])];
}
const toks = (s) => norm(String(s).replace(/[-–—]/g, " ")).split(" ").filter(Boolean).flatMap((w) => (/^\d+$/.test(w) ? numWords(w) : [w]));
function editOk(a, b) {
  if (a === b) return true;
  if (a.replace(/'/g, "") === b.replace(/'/g, "")) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, ed = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++ed > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } }
  return ed + (a.length - i) + (b.length - j) <= 1;
}
function alignMono(m, hypText) {
  const ref = []; m.lines.forEach((ln, li) => { for (const w of monoText(ln.en).split(/\s+/)) { const t = toks(w); t.forEach((x, k) => ref.push({ li, w: k === 0 ? w : "", t: x })); } });
  const hyp = toks(hypText), n = ref.length, M = hyp.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(M + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) L[i][j] = editOk(ref[i].t, hyp[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0; while (i < n && j < M) { if (editOk(ref[i].t, hyp[j]) && L[i][j] === L[i + 1][j + 1] + 1) { ref[i].ok = true; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  return { ref, hypN: hyp.length, matched: ref.filter((r) => r.ok).length };
}

// ── 기록 ──
function monoStreak() {
  let n = 0, d = today(); const any = (x) => (S.history[x]?.mono || 0) > 0;
  if (!any(d)) d = addDays(d, -1);
  while (any(d)) { n++; d = addDays(d, -1); }
  return n;
}
function monoStatsHtml() {
  const L = S.monoLog.filter((x) => x.wpm).slice(0, 20).reverse();
  const n = S.monoLog.length, mins = Math.round(S.monoLog.reduce((a, x) => a + (x.dur || 0), 0) / 60);
  let spark = `<p class="small muted" style="margin:8px 0 0">🎙 녹음하며 읽고 받아쓰기 채점을 하면 말하기 속도(분당 단어 수)와 완독률 그래프가 생겨요.</p>`;
  if (L.length >= 1) {
    const W = 300, H = 70, mx = Math.max(160, ...L.map((x) => x.wpm)), mn = 0;
    const px = (k) => (L.length === 1 ? W / 2 : (k / (L.length - 1)) * (W - 16) + 8), py = (v) => H - 6 - ((v - mn) / (mx - mn)) * (H - 14);
    const line = (f, c) => `<polyline fill="none" stroke="${c}" stroke-width="2" points="${L.map((x, k) => `${px(k).toFixed(1)},${py(f(x)).toFixed(1)}`).join(" ")}"/>` + L.map((x, k) => `<circle cx="${px(k).toFixed(1)}" cy="${py(f(x)).toFixed(1)}" r="2.6" fill="${c}"/>`).join("");
    const avg = (f, arr) => Math.round(arr.reduce((a, x) => a + f(x), 0) / arr.length);
    const first = L.slice(0, Math.min(3, L.length)), last = L.slice(-Math.min(3, L.length));
    spark = `<svg viewBox="0 0 ${W} ${H}" class="mspark" role="img" aria-label="말하기 속도·완독률 추이">
        <line x1="0" x2="${W}" y1="${py(130)}" y2="${py(130)}" class="mgoal"/><text x="${W - 4}" y="${py(130) - 3}" text-anchor="end" class="mgoal-t">원어민 보통 130</text>
        ${line((x) => x.wpm, "var(--accent)")}${line((x) => (x.acc || 0) * 1.6, "var(--warn)")}</svg>
      <div class="row small muted" style="gap:12px"><span><i class="mdot" style="background:var(--accent)"></i>분당 단어 수</span><span><i class="mdot" style="background:var(--warn)"></i>완독률</span>
      <span style="margin-left:auto">처음 ${avg((x) => x.wpm, first)} → 최근 <b style="color:var(--text)">${avg((x) => x.wpm, last)}</b> wpm · 완독 ${avg((x) => x.acc || 0, last)}%</span></div>`;
  }
  return `<div class="stats" style="margin-top:6px"><div class="stat"><b>🔥 ${monoStreak()}</b><span>독백 연속일</span></div><div class="stat"><b>${n}</b><span>낭독 횟수</span></div><div class="stat"><b>${mins}분</b><span>소리 내 읽은 시간</span></div></div>${spark}`;
}
function weakWordsHtml() {
  const top = Object.entries(S.monoWeak).filter(([, x]) => x.n >= 1).sort((a, b) => b[1].n - a[1].n || (b[1].at || "").localeCompare(a[1].at || "")).slice(0, 14);
  if (!top.length) return `<p class="small muted" style="margin:6px 0 0">받아쓰기 채점에서 자주 놓친 단어가 여기에 모여요. 눌러서 발음을 듣고, ▶로 실제 영상 예문을 보세요.</p>`;
  return `<div class="chips wrap" style="margin-top:8px">${top.map(([w, x]) => `<span class="chip wk-chip"><button class="lnk" data-say="${esc(w)}">🔊 ${esc(w)}</button><small>${x.n}회</small>${ygUrl(w) ? `<a class="lnk" href="${esc(ygUrl(w))}" target="_blank" rel="noopener" title="실제 영상 예문">▶</a>` : ""}<button class="lnk x" data-unweak="${esc(w)}" aria-label="목록에서 빼기">✕</button></span>`).join("")}</div>
    <p class="small muted" style="margin:6px 0 0">3번 이상 놓친 단어는 문장 째로 다시 읽어 보세요. 다 익혔으면 ✕로 빼면 돼요.</p>`;
}

// ── 화면 ──
function renderMono(v) {
  const m = todayMono();
  if (!m) { v.innerHTML = `<div class="card">독백 자료를 불러오지 못했어요.</div>`; return; }
  const words = m.lines.reduce((a, ln) => a + monoText(ln.en).split(/\s+/).length, 0);
  const secs = Math.round((words / 130) * 60 / monoRate);
  const doneToday = (todayH().mono || 0) > 0;
  const solo = monoStep === "solo" || monoStep === "erase";
  v.innerHTML = `
    <div class="chips" id="monoChips">
      <button class="chip" id="newMono">＋ 내 이야기로</button>
      ${allMonos().map((x) => `<button class="chip ${x.id === m.id ? "on" : ""}" data-id="${esc(x.id)}">${monoSaved(x) ? "★ " : ""}${S.done["mono:done:" + x.id] ? "✓ " : ""}${x.custom ? "✍ " : ""}${esc(x.title)}</button>`).join("")}
    </div>
    <div class="card scn-head">
      <div class="row spread"><span class="tag">${m.custom ? "내 이야기" : esc(m.topic || "독백")}</span><span class="small muted">${m.lines.length}문장 · ${words}단어 · 약 ${secs}초</span></div>
      <div class="row spread" style="margin-top:8px;gap:8px;align-items:center"><h2 style="margin:0">${esc(m.title)}</h2><button class="btn sm ${monoSaved(m) ? "primary" : ""}" id="saveMono" style="flex:none">${monoSaved(m) ? "★ 보관됨" : "☆ 보관"}</button></div>
      <p class="small muted" style="margin:4px 0 0">생각하지 말고 입으로 흘려 읽기. <b>/</b> 에서 짧게 숨 쉬고, 틀려도 멈추지 말고 끝까지.</p>
      <div class="seg" id="monoStepSeg" style="margin-top:12px">
        <button data-s="listen">① 듣기</button><button data-s="along">② 같이 읽기</button><button data-s="solo">③ 혼자 읽기</button><button data-s="erase">④ 지우기</button>
      </div>
      ${monoStep === "erase" ? `<div class="seg" id="monoRoundSeg">${MONO_ROUNDS.map(([k, l]) => `<button data-r="${k}" class="${monoRound === k ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
      <div class="row small" style="gap:8px;margin-top:2px"><span class="muted">속도</span><div class="seg" id="monoRateSeg" style="flex:1;margin:4px 0">${[[0.8, "0.8×"], [1, "1.0×"], [1.1, "1.1×"]].map(([r, l]) => `<button data-v="${r}" class="${monoRate === r ? "on" : ""}">${l}</button>`).join("")}</div>
        <label class="small muted" style="white-space:nowrap"><input type="checkbox" id="monoKo" ${monoKo ? "checked" : ""}> 한국어</label></div>
      <p class="small muted" style="margin:4px 0 0">${({ listen: "원어민 음성을 들으며 끊어 읽는 곳(하이라이트)만 눈으로 따라가세요.", along: "음성과 동시에 소리 내서 같이 읽어요(섀도잉). 음성보다 반 박자 늦어도 괜찮아요.", solo: "음성 없이 하이라이트 속도에 맞춰 혼자 읽어요. 🎙 녹음하면 원어민과 비교하고 채점할 수 있어요.", erase: monoRound === "cue" ? "줄거리와 한국어 문장만 보고 영어로 먼저 말해 보세요. 막히면 문장마다 '눌러서 영어 정답 보기'로 확인하고, 다시 눌러 가릴 수 있어요. 녹음하면 원문을 얼마나 살려 말했는지 채점해요." : "글자를 조금씩 지웠어요. 빈칸은 기억해서 채워 말하고, 막히면 빈칸을 누르고 있어 보세요(떼면 다시 가려져요). 1→4 단계로 갈수록 내 말이 돼요." })[monoStep]}</p>
    </div>
    <div class="card mono-text" id="monoText">${monoStep === "erase" && monoRound === "cue"
      ? `<div class="mcue">${esc(m.cue || "")}</div><p class="small muted" style="margin:6px 0 2px">한국어 문장을 보고 영어로 먼저 말해 보세요. 막히면 눌러서 정답을 확인하세요.</p>
        ${m.lines.map((_, li) => `<div class="mline mcueline" data-li="${li}">${cueLineHtml(m, li)}</div>`).join("")}`
      : m.lines.map((ln, li) => `<div class="mline" data-li="${li}"><p class="en">${chunksOf(ln.en).map((c, ci) => `<span class="mch" data-k="${li}-${ci}">${maskChunk(c, monoStep === "erase" ? monoRound : "full")}</span>`).join('<i class="mslash">/</i>')}</p>
        ${monoKo ? `<div class="ko">${esc(ln.ko)}</div>` : ""}${!solo && ln.tip ? `<div class="tip">${esc(ln.tip)}</div>` : ""}
        <div class="acts macts">${sayBtns(monoText(ln.en))}${starBtn({ en: monoText(ln.en), ko: ln.ko, src: m.title })}</div></div>`).join("")}</div>
    <div class="card" id="monoResult" ${monoLast && monoLast.mono === m.id ? "" : "hidden"}></div>
    <div class="sticky-actions">
      ${solo ? `<button class="btn" id="monoGo">${monoStep === "erase" && monoRound === "cue" ? "⏱ 타이머만" : "▶ 녹음 없이"}</button><button class="btn primary" id="monoRec">🎙 녹음하며 시작</button>`
        : `<button class="btn primary" id="monoGo">▶ ${monoStep === "listen" ? "듣기" : "같이 읽기"} 시작</button><button class="btn" id="monoDone">${doneToday ? "✓ 오늘 완료" : "완료 기록"}</button>`}
    </div>
    <div class="card"><div class="row spread"><h3>내 녹음</h3><span class="small muted">이 기기에만 저장</span></div><div id="monoRecs"><span class="spinner"></span></div></div>
    <div class="card"><h3>자주 놓친 단어</h3>${weakWordsHtml()}</div>
    <div class="card"><div class="row spread"><h3>낭독 기록</h3><span class="small muted">매일 1개 · 30~60초</span></div>${monoStatsHtml()}</div>`;

  const seg = (id, attr, fn) => { const el = $(id); if (!el) return; [...el.children].forEach((b) => b.dataset[attr] !== undefined && b.classList.toggle("on", String(b.dataset[attr]) === String(fn.cur()))); el.onclick = (e) => { const b = e.target.closest("button"); if (b) { stopMono(); fn.set(b.dataset[attr]); renderMono(v); } }; };
  seg("#monoStepSeg", "s", { cur: () => monoStep, set: (x) => (monoStep = x) });
  seg("#monoRoundSeg", "r", { cur: () => monoRound, set: (x) => (monoRound = x) });
  seg("#monoRateSeg", "v", { cur: () => monoRate, set: (x) => (monoRate = +x) });
  $("#monoKo").onchange = (e) => { monoKo = e.target.checked; renderMono(v); };
  const ansKey = m.id + "|" + monoStep + "|" + monoRound;
  if (ansKey !== monoAnsKey) { monoAnsKey = ansKey; monoAns = new Set(); }   // 다른 독백·단계로 가면 정답을 다시 모두 가림
  if (monoStep === "erase" && monoRound === "cue") {
    $("#monoText").onclick = (e) => {
      const b = e.target.closest("[data-ans]"); if (!b) return;
      const li = +b.dataset.ans; monoAns.has(li) ? monoAns.delete(li) : monoAns.add(li);
      const line = b.closest(".mcueline"); if (line) line.innerHTML = cueLineHtml(m, li);   // 그 문장만 바꿔 스크롤 위치 유지
    };
  }
  $("#monoChips").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    stopMono();
    if (b.id === "newMono") return newMonoSheet();
    S.done["mpick:" + today()] = b.dataset.id; save(); monoLast = null; renderMono(v);
  };
  const go = $("#monoGo"); if (go) go.onclick = () => (monoRun ? stopMono() : runMono(m, false));
  const rc = $("#monoRec"); if (rc) rc.onclick = () => (monoRun ? finishRec() : runMono(m, true));
  const dn = $("#monoDone"); if (dn) dn.onclick = () => { markMonoDone(m, null); renderMono(v); };
  v.querySelectorAll("[data-unweak]").forEach((b) => (b.onclick = () => { delete S.monoWeak[b.dataset.unweak]; save(); renderMono(v); }));
  $("#saveMono").onclick = () => {
    if (m.custom) { toast("내 이야기 독백은 이미 보관돼 있어요 (복습 › 독백)"); return; }
    S.done["mfav:" + m.id] = !S.done["mfav:" + m.id]; save();
    toast(S.done["mfav:" + m.id] ? "보관했어요 ★ 복습 › 독백에서 볼 수 있어요" : "보관을 해제했어요"); renderMono(v);
  };
  if (monoLast && monoLast.mono === m.id) showMonoResult(m);
  renderRecs(m);
}

function markMonoDone(m, sess) {
  if (!S.done["mono:" + today() + ":" + m.id]) { S.done["mono:" + today() + ":" + m.id] = true; log("mono"); }
  S.done["mono:done:" + m.id] = true;
  if (sess) { S.monoLog.unshift(sess); S.monoLog = S.monoLog.slice(0, 300); }
  save();
}

function hl(key) {
  document.querySelectorAll("#monoText .mch.now").forEach((x) => x.classList.remove("now"));
  if (!key) return;
  const el = document.querySelector(`#monoText .mch[data-k="${key}"]`);
  if (el) { el.classList.add("now"); el.classList.add("past"); const line = el.closest(".mline"); if (line && !isVisible(line)) line.scrollIntoView({ block: "center", behavior: "smooth" }); }
}
const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 140; };

function stopMono() {
  if (!monoRun) return;
  monoRun.stop = true; window.speechSynthesis?.cancel();
  if (monoRun.rec && !monoRun.finishing) { monoRun.rec.stop(); }   // 녹음은 버림
  monoRun = null; hl(null);
  const go = $("#monoGo"); if (go) go.textContent = go.textContent.replace("■ 멈춤", "▶ 다시");
}

async function runMono(m, withRec) {
  const run = (monoRun = { stop: false, rec: null });
  document.querySelectorAll("#monoText .mch").forEach((x) => x.classList.remove("past"));
  const go = $("#monoGo"), rc = $("#monoRec");
  if (withRec) {
    try { run.rec = await startRecorder(); } catch (e) { toast(e.message, 3500); monoRun = null; return; }
    if (rc) rc.textContent = "■ 다 읽었어요"; if (go) go.disabled = true;
    toast("녹음 중 — 끝까지 읽고 '다 읽었어요'를 누르세요");
  } else if (go) go.textContent = "■ 멈춤";
  const cueOnly = monoStep === "erase" && monoRound === "cue";
  if (monoStep === "listen" || monoStep === "along") {
    for (let li = 0; li < m.lines.length && !run.stop; li++) {
      await speakChunks(m.lines[li].en, monoRate, (ci) => !run.stop && hl(li + "-" + ci));
      if (!run.stop) await sleep(monoStep === "along" ? 650 : 400);
    }
    if (!run.stop) { hl(null); monoRun = null; if (go) go.textContent = "▶ 다시"; if (monoStep === "along") { markMonoDone(m, { id: uid(), at: new Date().toISOString(), d: today(), m: m.id, t: m.title, mode: "along", dur: 0 }); toast("같이 읽기 완료! 이제 ③ 혼자 읽기로 넘어가 보세요"); } }
    return;
  }
  if (cueOnly) { if (!withRec) { toast("줄거리를 보며 말해 보세요. 다 했으면 ■ 멈춤"); } return; }
  // 혼자 읽기·지우기: 음성 없이 하이라이트로 속도 안내 (원어민 보통 130 wpm 기준)
  const wps = (130 / 60) * monoRate;
  for (let li = 0; li < m.lines.length && !run.stop; li++) {
    const cs = chunksOf(m.lines[li].en);
    for (let ci = 0; ci < cs.length && !run.stop; ci++) { hl(li + "-" + ci); await sleep((cs[ci].split(/\s+/).length / wps) * 1000 + 220); }
    await sleep(450);
  }
  if (run.stop) return;
  hl(null);
  if (!withRec) { monoRun = null; if (go) go.textContent = "▶ 다시"; markMonoDone(m, { id: uid(), at: new Date().toISOString(), d: today(), m: m.id, t: m.title, mode: monoStep + (monoStep === "erase" ? ":" + monoRound : ""), dur: 0 }); toast("끝까지 읽었어요 👏 다음엔 🎙 녹음하며 해 보세요"); }
  else toast("다 읽었으면 '■ 다 읽었어요'를 누르세요");
}

async function finishRec() {
  const run = monoRun; if (!run || !run.rec) return stopMono();
  run.finishing = true; run.stop = true; monoRun = null; hl(null);
  const m = todayMono(), { blob, dur } = await run.rec.stop();
  const rc = $("#monoRec"), go = $("#monoGo"); if (rc) rc.textContent = "🎙 다시 녹음"; if (go) go.disabled = false;
  if (dur < 3) return toast("녹음이 너무 짧아요");
  const id = uid(), mode = monoStep + (monoStep === "erase" ? ":" + monoRound : "");
  const rec = { id, code: CODE, mono: m.id, title: m.title, at: new Date().toISOString(), d: today(), dur: Math.round(dur), mode, blob };
  await recDB.put(rec);
  monoLast = { mono: m.id, recId: id, dur, mode, url: URL.createObjectURL(blob), status: "stt" };
  showMonoResult(m); renderRecs(m);
  try {
    const t = await transcribe(blob);
    const al = alignMono(m, t.text);
    const acc = Math.round((al.matched / Math.max(1, al.ref.length)) * 100), wpm = Math.round(al.hypN / (dur / 60));
    Object.assign(monoLast, { status: "done", text: t.text, al, acc, wpm });
    // 놓친 단어 기록 (짧은 기능어 제외) — 문장 일부까지 같이 기억해 영상 예문 검색에 사용
    const missed = al.ref.filter((r) => !r.ok && r.t.length >= 3 && !STOP.has(r.t));
    const now = new Date().toISOString();
    for (const r of missed.slice(0, 20)) { const x = S.monoWeak[r.t] || (S.monoWeak[r.t] = { n: 0 }); x.n++; x.at = now; x.m = m.id; }
    for (const r of al.ref) if (r.ok && S.monoWeak[r.t]) { S.monoWeak[r.t].hit = (S.monoWeak[r.t].hit || 0) + 1; }
    const keys = Object.keys(S.monoWeak); if (keys.length > 120) keys.sort((a, b) => (S.monoWeak[a].at || "").localeCompare(S.monoWeak[b].at || "")).slice(0, keys.length - 120).forEach((k) => delete S.monoWeak[k]);
    if (mode !== "erase:cue" && al.matched) {
      const lastLi = Math.max(...al.ref.filter((r) => r.ok).map((r) => r.li)); let n = 0;
      for (let li = 0; li <= lastLi && n < 6; li++) {
        const rs = al.ref.filter((r) => r.li === li); if (!rs.length) continue;
        const a2 = rs.filter((r) => r.ok).length / rs.length; if (a2 >= 0.8) continue;
        const miss = rs.filter((r) => !r.ok && r.t.length >= 3 && !STOP.has(r.t)).map((r) => r.t);
        addWrong({ ko: m.lines[li].ko || "", en: monoText(m.lines[li].en), src: "독백 · " + m.title }, "", { why: `독백 낭독 ${Math.round(a2 * 100)}%${miss.length ? ` — 놓친 단어: ${miss.slice(0, 5).join(", ")}` : ""}`, types: [] }); n++;
      }
      if (n) monoLast.saved = n;
    }
    rec.acc = acc; rec.wpm = wpm; await recDB.put(rec);
    markMonoDone(m, { id, at: now, d: today(), m: m.id, t: m.title, mode, dur: Math.round(dur), wpm, acc });
  } catch (e) {
    Object.assign(monoLast, { status: "err", err: e.message });
    markMonoDone(m, { id, at: new Date().toISOString(), d: today(), m: m.id, t: m.title, mode, dur: Math.round(dur) });
  }
  if (TAB === "mono") renderMono($("#view"));
}

function showMonoResult(m) {
  const box = $("#monoResult"); if (!box || !monoLast) return; box.hidden = false;
  const r = monoLast;
  let body = "";
  if (r.status === "stt") body = `<p class="small muted"><span class="spinner"></span> 받아쓰기로 채점하는 중… (10초 안팎)</p>`;
  else if (r.status === "err") body = `<p class="small" style="color:var(--bad)">채점 실패: ${esc(r.err)}</p><p class="small muted">녹음은 저장됐어요. 아래에서 원어민과 번갈아 들어 보세요.</p>`;
  else {
    const byLine = m.lines.map((_, li) => r.al.ref.filter((x) => x.li === li));
    body = `<div class="stats" style="margin:8px 0"><div class="stat"><b>${r.acc}%</b><span>완독률</span></div><div class="stat"><b>${r.wpm}</b><span>분당 단어</span></div><div class="stat"><b>${Math.round(r.dur)}초</b><span>걸린 시간</span></div></div>
      ${r.saved ? `<p class="small" style="margin:0 0 6px">📥 단어를 많이 놓친 ${r.saved}문장을 복습함에 저장했어요.</p>` : ""}
      <p class="small muted" style="margin:0 0 6px">${r.acc >= 90 ? "아주 좋아요! 거의 다 또렷하게 들렸어요 👏" : r.acc >= 70 ? "좋아요. 빨간 단어만 따로 몇 번 소리 내 보세요." : "빨간 단어가 잘 안 들렸어요. ② 같이 읽기로 한 번 더 듣고 다시 해 보세요."} ${r.wpm < 100 ? "속도는 조금 더 붙여도 돼요." : r.wpm > 165 ? "조금 천천히 또박또박 해도 돼요." : ""}</p>
      <div class="mdiff">${byLine.map((ws) => `<p>${ws.filter((x) => x.w).map((x) => `<span class="${x.ok ? "ok" : "miss"}">${esc(x.w)}</span>`).join(" ")}</p>`).join("")}</div>
      <details class="small muted"><summary>들린 그대로 보기</summary><p>${esc(r.text || "(들린 말 없음)")}</p></details>`;
  }
  box.innerHTML = `<div class="row spread"><h3>방금 낭독</h3><span class="small muted">${esc(({ solo: "혼자 읽기", "erase:full": "지우기 1", "erase:key": "지우기 2", "erase:first": "지우기 3", "erase:cue": "지우기 4" })[r.mode] || r.mode)}</span></div>
    <div class="grid2" style="margin-top:8px"><button class="btn" id="abMine">▶ 내 녹음</button><button class="btn" id="abNative">🔊 원어민</button></div>
    <button class="btn ghost" id="abAlt" style="width:100%;margin-top:6px">⇄ 문장별로 원어민 → 나 번갈아 듣기</button>
    ${body}`;
  const audio = new Audio(r.url);
  $("#abMine").onclick = () => { window.speechSynthesis?.cancel(); audio.currentTime = 0; audio.play(); };
  $("#abNative").onclick = async () => { audio.pause(); for (const ln of m.lines) { await speak(monoText(ln.en), undefined, (S.settings.rate || 0.95) * monoRate); await sleep(250); } };
  $("#abAlt").onclick = () => abAlternate(m, r, audio);
}
// 문장별 번갈아 듣기: 받아쓰기 단어 시각이 있으면 그 문장 구간만, 없으면 문장 길이 비율로 내 녹음을 자름
async function abAlternate(m, r, audio) {
  const lens = m.lines.map((ln) => monoText(ln.en).split(/\s+/).length), tot = lens.reduce((a, b) => a + b, 0);
  let acc = 0; const cuts = lens.map((n) => { const s = (acc / tot) * r.dur; acc += n; return [s, (acc / tot) * r.dur]; });
  const btn = $("#abAlt"); btn.disabled = true;
  for (let li = 0; li < m.lines.length; li++) {
    document.querySelectorAll("#monoText .mline").forEach((x) => x.classList.toggle("now", +x.dataset.li === li));
    btn.textContent = `⇄ ${li + 1}/${m.lines.length} 원어민`;
    await speak(monoText(m.lines[li].en), undefined, (S.settings.rate || 0.95) * monoRate);
    await sleep(250);
    btn.textContent = `⇄ ${li + 1}/${m.lines.length} 나`;
    const [s, e] = cuts[li]; audio.currentTime = Math.max(0, s - 0.15); await audio.play().catch(() => {});
    await new Promise((res) => { const t = setInterval(() => { if (audio.currentTime >= e + 0.25 || audio.paused || audio.ended) { clearInterval(t); audio.pause(); res(); } }, 60); });
    await sleep(350);
  }
  document.querySelectorAll("#monoText .mline").forEach((x) => x.classList.remove("now"));
  btn.disabled = false; btn.textContent = "⇄ 문장별로 원어민 → 나 번갈아 듣기";
}

async function renderRecs(m) {
  const box = $("#monoRecs"); if (!box) return;
  const all = (await recDB.all()).sort((a, b) => b.at.localeCompare(a.at));
  const mine = all.filter((x) => x.mono === m.id);
  if (!$("#monoRecs")) return;
  if (!all.length) { box.innerHTML = `<p class="small muted" style="margin:6px 0 0">③ 혼자 읽기나 ④ 지우기에서 🎙 녹음하면 여기에 쌓여요. 1주 전 내 목소리와 비교해 들어 보세요.</p>`; return; }
  const wkAgo = mine.find((x) => x.d <= addDays(today(), -6));
  const row = (x) => `<div class="mrec"><button class="btn sm" data-play="${x.id}">▶</button><div style="flex:1;min-width:0"><b>${esc(x.d.slice(5).replace("-", "/"))}</b> <span class="small muted">${esc(x.mode.startsWith("erase") ? "지우기 " + ({ full: 1, key: 2, first: 3, cue: 4 })[x.mode.split(":")[1]] : "혼자 읽기")} · ${x.dur}초${x.wpm ? ` · ${x.wpm}wpm · 완독 ${x.acc}%` : ""}</span></div><button class="lnk x" data-delrec="${x.id}" aria-label="삭제">✕</button></div>`;
  box.innerHTML = (wkAgo && mine[0] && mine[0].id !== wkAgo.id ? `<div class="mcmp"><b>1주 전과 비교</b><div class="grid2" style="margin-top:6px"><button class="btn sm" data-play="${wkAgo.id}">▶ ${esc(wkAgo.d.slice(5).replace("-", "/"))} (예전)</button><button class="btn sm primary" data-play="${mine[0].id}">▶ ${esc(mine[0].d.slice(5).replace("-", "/"))} (최근)</button></div></div>` : "")
    + (mine.length ? mine.slice(0, 6).map(row).join("") : `<p class="small muted">이 독백의 녹음은 아직 없어요.</p>`)
    + (all.length > mine.length ? `<details class="small" style="margin-top:6px"><summary class="muted">다른 독백 녹음 ${all.length - mine.length}개</summary>${all.filter((x) => x.mono !== m.id).slice(0, 20).map((x) => row(x).replace("<b>", `<b>${esc(x.title || "")} · `)).join("")}</details>` : "")
    + `<p class="small muted" style="margin:6px 0 0">녹음 파일은 용량 때문에 이 기기 브라우저에만 저장돼요(다른 기기로는 기록 숫자만 이어져요).</p>`;
  let cur = null;
  box.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => { const x = all.find((r) => r.id === b.dataset.play); if (!x) return; if (cur) cur.pause(); window.speechSynthesis?.cancel(); cur = new Audio(URL.createObjectURL(x.blob)); cur.play(); }));
  box.querySelectorAll("[data-delrec]").forEach((b) => (b.onclick = async () => { if (confirm("이 녹음을 지울까요?")) { await recDB.del(b.dataset.delrec); renderRecs(m); } }));
}

function newMonoSheet() {
  openSheet(`<h2>내 이야기로 독백 만들기</h2>
    <p class="small muted">오늘 있었던 일이나 말하고 싶은 주제를 한국어로 편하게 적으면, 원어민이 혼자 이야기하듯 6~8문장 구어체 독백으로 바꿔 드려요. 끊어 읽는 곳(/)과 연음 팁도 같이 붙어요.</p>
    <textarea id="mIn" rows="5" placeholder="예: 오늘 아이 학교에서 학부모 상담이 있었는데 선생님이 아이가 수학을 잘한다고 칭찬해서 기분이 좋았다. 끝나고 같이 아이스크림을 먹었다."></textarea>
    <button class="btn primary big" id="mGo" style="margin-top:10px">독백 만들기</button><div id="mOut" style="margin-top:10px"></div>`);
  $("#mGo").onclick = async () => {
    const t = $("#mIn").value.trim(); if (t.length < 6) return toast("조금 더 자세히 적어 주세요");
    $("#mGo").disabled = true; $("#mOut").innerHTML = '<p class="small muted"><span class="spinner"></span> 만드는 중… (10~20초)</p>';
    try {
      const r = await ai("monologue", { text: t });
      const lines = (r.lines || []).filter((l) => l.en && l.ko);
      if (lines.length < 4) throw new Error("문장이 부족해요. 다시 시도해 주세요");
      const mono = { id: "c-" + uid(), custom: true, title: r.title || t.slice(0, 16), topic: "내 이야기", cue: r.cue || "", src: t.slice(0, 300), lines: lines.map((l) => ({ en: l.en, ko: l.ko, tip: l.tip || "" })), at: new Date().toISOString() };
      S.monos.unshift(mono); S.monos = S.monos.slice(0, 60);
      S.done["mpick:" + today()] = mono.id; monoStep = "listen"; monoLast = null; save();
      closeSheet(); go("mono"); toast("만들었어요! ① 듣기부터 시작해 보세요");
    } catch (e) { $("#mOut").innerHTML = `<p class="small" style="color:var(--bad)">${esc(e.message)}</p>`; $("#mGo").disabled = false; }
  };
}

// ── 화면 ────────────────────────────────────────────────
const TITLES = { home: "홈", speak: "오늘의 스피킹", mono: "독백 낭독", write: "영작 훈련", train: "동사·5형식·시제", vault: "복습·보관함" };
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
  if (TAB !== "mono") stopMono();
  ({ home: renderHome, speak: renderSpeak, mono: renderMono, write: renderWrite, train: renderTrain, vault: renderVault })[TAB]($("#view"));
  curAfterRender(TAB, $("#view"));
}
$("#tabbar").onclick = (e) => { const b = e.target.closest("button"); if (b) go(b.dataset.tab); };
$("#toolsBtn").onclick = () => openTools();
$("#codeChip").onclick = () => {
  openSheet(`<h2>코드 ${esc(CODE)}</h2><p class="small muted">${esc($("#syncDot").title)}</p>
    <div class="card tight small">학습을 시작한 날: ${esc(S.created)}<br>저장 문장 ${S.saved.length} · 시나리오 ${S.scenarios.length} · 복습 ${S.wrong.filter((w) => !w.mastered).length} · 단어 ${S.words.length}</div>
    <div class="label">발음 기본값</div><div class="seg" id="accSeg">${[["en-US", "미국"], ["en-GB", "영국"], ["en-NZ", "뉴질랜드"], ["en-AU", "호주"]].map(([v, l]) => `<button data-v="${v}" class="${S.settings.accent === v ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="label">말하기 속도</div><div class="seg" id="rateSeg">${[[0.8, "천천히"], [0.95, "보통"], [1.1, "빠르게"]].map(([v, l]) => `<button data-v="${v}" class="${S.settings.rate == v ? "on" : ""}">${l}</button>`).join("")}</div>
    <p class="small muted">기기에 뉴질랜드 음성이 없으면 비슷한 영어 음성으로 재생돼요.</p>
    <div class="label">따라 말하기 채점</div><div class="seg" id="sttSeg">${[["ai", "AI 받아쓰기(정확)"], ["browser", "브라우저(빠름)"]].map(([v, l]) => `<button data-v="${v}" class="${(S.settings.stt || "ai") === v ? "on" : ""}">${l}</button>`).join("")}</div>
    <p class="small muted">AI 받아쓰기는 녹음을 Whisper로 받아 적어 단어마다 맞음·빠짐을 보여 줘요. 하루 한도를 넘으면 자동으로 브라우저 인식을 써요.</p>
    <div class="label">앱 설치</div>${installHtml()}
    <button class="btn big" id="syncNow" style="margin-top:6px">지금 동기화</button>
    <button class="btn big ghost" id="logout" style="margin-top:8px">다른 코드로 바꾸기</button>`);
  $("#accSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.settings.accent = b.dataset.v; save(); [...$("#accSeg").children].forEach((x) => x.classList.toggle("on", x === b)); speak("Kia ora, how's it going?"); };
  if ($("#installApp")) $("#installApp").onclick = async () => { const p = installPrompt; if (!p) return; installPrompt = null; p.prompt(); try { await p.userChoice; } catch {} closeSheet(); };
  $("#sttSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.settings.stt = b.dataset.v; save(); [...$("#sttSeg").children].forEach((x) => x.classList.toggle("on", x === b)); };
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


// ── 홈 대시보드 조각 ─────────────────────────────────────
const weekMonday = () => { const d = new Date(today() + "T12:00:00Z"); return addDays(today(), -((d.getUTCDay() + 6) % 7)); };
function weeklyGoals() {
  const mon = weekMonday(), end = addDays(mon, 6), cnt = { speak: 0, write: 0 };
  for (const k of Object.keys(S.done)) { const m = k.match(/^(speak|write):(\d{4}-\d\d-\d\d):/); if (m && m[2] >= mon && m[2] <= end) cnt[m[1]]++; }
  return cnt;
}
function heatmapHtml() {
  const mon = addDays(weekMonday(), -77), cells = [];
  const tot = (d) => Object.values(S.history[d] || {}).reduce((a, b) => a + b, 0);
  for (let i = 0; i < 84; i++) {
    const d = addDays(mon, i), n = tot(d), lv = d > today() ? "f" : n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 30 ? 3 : 4;
    cells.push(`<i class="hm l${lv}" title="${d} · ${n}문장"></i>`);
  }
  // 열 = 주(월~일), 첫 열이 가장 오래된 주
  const cols = []; for (let w = 0; w < 12; w++) cols.push(cells.slice(w * 7, w * 7 + 7).join(""));
  return `<div class="heat">${cols.map((c) => `<div class="hw">${c}</div>`).join("")}</div>
    <div class="row small muted" style="justify-content:flex-end;gap:4px;margin-top:6px">적음 <i class="hm l0"></i><i class="hm l1"></i><i class="hm l2"></i><i class="hm l3"></i><i class="hm l4"></i> 많음</div>`;
}
function reviewStatsHtml() {
  const act = S.wrong.filter((w) => !w.del), mastered = act.filter((w) => w.mastered).length;
  if (!act.length) return `<p class="small muted" style="margin:6px 0 0">아직 복습할 문장이 없어요. 영작·퀴즈에서 틀린 문장이 여기에 쌓이고 간격 복습으로 익혀요.</p>`;
  const labels = ["새 오답", "1일", "3일", "7일", "14일", "30일"];
  const bars = labels.map((_, b) => act.filter((w) => !w.mastered && (w.box || 0) === b).length);
  const mx = Math.max(1, ...bars, mastered);
  const bar = (n, lab, cls) => `<div class="${cls || ""}"><b class="small">${n}</b><i style="height:${(n / mx) * 56 + 3}px"></i><span>${lab}</span></div>`;
  // 최근 30일 '완전히 익힘' 누적 추이
  const days = [...Array(30)].map((_, k) => addDays(today(), k - 29));
  const after = (d) => Object.entries(S.history).filter(([x]) => x > d).reduce((a, [, h]) => a + (h.mastered || 0), 0);
  const pts = days.map((d, k) => [k * (280 / 29), 56 - (Math.max(0, mastered - after(d)) / Math.max(1, mastered)) * 50]);
  const line = mastered ? `<svg viewBox="0 0 280 60" class="spark" role="img" aria-label="익힌 문장 누적"><polyline fill="none" stroke="var(--accent)" stroke-width="2.5" points="${pts.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join(" ")}"/></svg>` : "";
  return `<div class="bars7">${bars.map((n, b) => bar(n, labels[b])).join("")}${bar(mastered, "익힘 ✓", "ok")}</div>
    <p class="small muted" style="margin:6px 0 0">간격 복습 단계별 문장 수 (아래 숫자 = 다음 복습까지 간격). 익힌 문장 <b>${mastered}</b>개${mastered ? " · 최근 30일 누적" : ""}</p>${line}`;
}
/** 최근 7일 학습 리포트(그 전 7일과 비교) */
function weeklyReportHtml() {
  const span = (from) => [...Array(7)].map((_, k) => addDays(today(), from + k));
  const cur = span(-6), prev = span(-13);
  const sentOf = (x) => (x.speak || 0) + (x.write || 0) + (x.drill || 0) + (x.review || 0) + (x.shadow || 0) + (x.dictation || 0) + (x.weak || 0) + (x.mono || 0) * 6 + (x.roleplay || 0) * 6;
  const sum = (days, f) => days.reduce((a, d) => a + f(S.history[d] || {}), 0);
  const active = (days) => days.filter((d) => Object.values(S.history[d] || {}).some((v) => v > 0)).length;
  const sc = sum(cur, sentOf), sp = sum(prev, sentOf), ac = active(cur);
  if (!sc && !sp) return `<p class="small muted" style="margin:6px 0 0">이번 주에 연습을 시작하면 7일 단위로 얼마나 했는지, 복습 정답률과 자주 틀린 유형을 정리해 드려요.</p>`;
  const okDays = cur.filter((d) => d >= "2026-11-25");   // 복습 정답 수(review_ok)는 이날부터 기록
  const rv = sum(okDays, (x) => x.review || 0), rok = sum(okDays, (x) => x.review_ok || 0), mast = sum(cur, (x) => x.mastered || 0), mono = sum(cur, (x) => x.mono || 0);
  const from = cur[0], newWrong = S.wrong.filter((w) => !w.del && (w.at || "").slice(0, 10) >= from);
  const manual = newWrong.filter((w) => w.manual).length;
  const cnt = {}; for (const e of S.errors) if ((e.d || "") >= from) cnt[e.t] = (cnt[e.t] || 0) + 1;
  const topErr = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  const best = cur.reduce((a, d) => (sentOf(S.history[d] || {}) > sentOf(S.history[a] || {}) ? d : a), cur[0]);
  const diff = sp ? Math.round(((sc - sp) / sp) * 100) : null;
  const next7 = S.wrong.filter((w) => !w.del && !w.mastered && w.due <= addDays(today(), 7)).length;
  const wd = (d) => ["일", "월", "화", "수", "목", "금", "토"][new Date(d + "T12:00:00Z").getUTCDay()];
  const tips = [];
  if (ac < 4) tips.push(`이번 주는 ${ac}일 공부했어요. 하루 10분이라도 <b>매일</b> 하면 말이 더 빨리 붙어요.`);
  if (rv && rok / rv < 0.6) tips.push(`복습 정답률이 ${Math.round((rok / rv) * 100)}%예요. 틀린 문장은 🔊 듣고 소리 내 3번 따라 한 뒤 다시 써 보세요.`);
  if (topErr) tips.push(`이번 주 가장 많이 틀린 유형은 <b>${esc(topErr[0])}</b>(${topErr[1]}회) — 홈의 '내 약점 TOP 3'에서 연습 5문장을 해 보세요.`);
  if (!mono) tips.push("독백 낭독을 한 번도 안 했어요. 30초짜리 하나만 소리 내 읽어도 구어체 감각이 살아나요.");
  if (next7 > 60) tips.push(`앞으로 7일 안에 복습할 문장이 ${next7}개예요. 하루 ${REVIEW_DAILY_CAP}문장씩 꾸준히 해야 밀리지 않아요.`);
  if (!tips.length) tips.push("좋은 흐름이에요! 이번 주처럼만 이어 가면 돼요. 👍");
  const stat = (b, t) => `<div class="stat"><b>${b}</b><span>${t}</span></div>`;
  return `<div class="stats" style="grid-template-columns:repeat(3,1fr);margin-top:8px">
      ${stat(`${ac}/7`, "공부한 날")}${stat(sc, `연습 문장${diff == null ? "" : `<br><small class="${diff >= 0 ? "up" : "down"}">지난주 대비 ${diff >= 0 ? "+" : ""}${diff}%</small>`}`)}${stat(rv ? Math.round((rok / rv) * 100) + "%" : "–", `복습 정답률${rv ? `<br><small class="muted">${rok}/${rv}문장</small>` : ""}`)}
    </div>
    <div class="wrrow small"><span>✅ 완전히 익힘 <b>${mast}</b></span><span>🎙 독백 <b>${mono}</b>번</span><span>📥 새 복습 문장 <b>${newWrong.length}</b>${manual ? ` (직접 ${manual})` : ""}</span>${sc ? `<span>⭐ 가장 많이 한 날 <b>${wd(best)}요일</b></span>` : ""}</div>
    <ul class="wrtips small">${tips.slice(0, 3).map((t) => `<li>${t}</li>`).join("")}</ul>`;
}
function weaknessHtml() {
  const from = addDays(today(), -30), cnt = {};
  for (const e of S.errors) if ((e.d || "") >= from) cnt[e.t] = (cnt[e.t] || 0) + 1;
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!top.length) return `<p class="small muted" style="margin:6px 0 0">영작·복습에서 AI 교정을 받으면 자주 틀리는 유형(관사·시제·전치사 등)을 모아서 보여 드려요.</p>`;
  const mx = top[0][1];
  return top.map(([t, n], i) => `<div class="wk"><span class="wk-r">${i + 1}</span><div style="flex:1"><div class="row spread"><b>${esc(t)}</b><span class="small muted">${n}회</span></div><div class="wk-bar"><i style="width:${(n / mx) * 100}%"></i></div></div><button class="btn sm" data-weak="${esc(t)}">연습 5문장</button></div>`).join("")
    + `<p class="small muted" style="margin:6px 0 0">최근 30일 교정에서 가장 자주 나온 유형 TOP ${top.length}. 연습은 그 유형으로 틀렸던 문장 중에서 골라요.</p>`;
}
function speakStatsHtml() {
  const recs = Object.values(S.speak);
  if (!recs.length) return `<p class="small muted" style="margin:6px 0 0">스피킹에서 🎙 따라 말하기를 하면 문장별 일치율이 기록돼요.</p>`;
  const avg = Math.round(recs.reduce((a, r) => a + r.last, 0) / recs.length), gain = Math.round(recs.reduce((a, r) => a + (r.last - r.first), 0) / recs.length), low = recs.filter((r) => r.last < 70).length;
  return `<div class="stats" style="grid-template-columns:repeat(3,1fr);margin-top:6px"><div class="stat"><b>${avg}%</b><span>평균 일치율</span></div><div class="stat"><b>${gain >= 0 ? "+" : ""}${gain}p</b><span>첫 시도 대비</span></div><div class="stat"><b>${low}</b><span>다시 연습</span></div></div>`;
}

// 이번 주(월요일 시작) 약점 맞춤 연습: 최근 30일 가장 많이 틀린 유형으로 AI가 새 문장 5개를 만들고, 틀리면 복습으로
const weekStart = () => { const d = new Date(today() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
function topWeakType() {
  const from = addDays(today(), -30), cnt = {};
  for (const e of S.errors) if ((e.d || "") >= from && e.t !== "기타") cnt[e.t] = (cnt[e.t] || 0) + 1;
  return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}
function weeklyWeakHtml() {
  const wk = S.done["wkset:" + weekStart()], type = wk?.type || topWeakType();
  if (!type) return `<p class="small muted" style="margin:6px 0 0">영작·복습에서 교정을 받으면, 매주 월요일 가장 많이 틀린 유형으로 새 연습 5문장을 만들어 드려요.</p>`;
  return `<p class="small" style="margin:6px 0 8px">이번 주 약점: <b>${esc(type)}</b>${wk ? ` · 5문장 중 ${wk.ok || 0}개 맞힘${wk.tries ? ` (${wk.tries}번 풀이)` : ""}` : ""}</p>
    <div id="wkSetQ"></div><button class="btn ${wk ? "" : "primary"}" id="wkSetGo">${wk ? "다시 풀기" : "AI로 이번 주 5문장 만들기"}</button>`;
}
async function runWeeklyWeak(v) {
  const key = "wkset:" + weekStart(), btn = $("#wkSetGo");
  let wk = S.done[key];
  if (!wk) {
    const type = topWeakType(); if (!type) return;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 만드는 중…';
    const ex = S.wrong.filter((w) => !w.del && (w.types || []).includes(type) && w.mine).slice(0, 4).map((w) => `- ${w.mine} → ${w.en}`).join("\n");
    try {
      const r = await ai("weak_drill", { type, examples: ex });
      wk = S.done[key] = { type, items: r.items.filter((i) => i.ko && i.en).slice(0, 5), ok: 0, tries: 0 }; save();
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "AI로 이번 주 5문장 만들기"; return; }
  }
  btn.remove(); wk.tries = (wk.tries || 0) + 1;
  quiz($("#wkSetQ"), wk.items.map((i) => ({ ko: i.ko, en: i.en, note: i.note })), { kind: "weak", src: `약점 연습 · ${wk.type}`, target: wk.type, onDone: (ok) => { wk.ok = Math.max(wk.ok || 0, +ok || 0); save(); } });
}

function weakPractice(type) {
  const items = S.wrong.filter((w) => !w.del && !w.mastered && (w.types || []).includes(type)).slice(0, 5);
  if (!items.length) return toast("이 유형으로 저장된 틀린 문장이 아직 없어요. 영작을 더 해 보세요");
  openSheet(`<h2>약점 연습 · ${esc(type)}</h2><p class="small muted">이 유형으로 틀렸던 문장 ${items.length}개를 다시 써 봐요.</p><div id="wkQ"></div>`);
  quiz($("#wkQ"), items.map((w) => ({ ko: w.ko, en: w.en, _ref: w })), { kind: "review", onDone: () => { render(); } });
}

// 홈
// 옆 사람이 보지 않게 학습 코드는 앞 두 글자만 (코드 설정 시트에서는 전체)
const maskCode = (c) => String(c || "").slice(0, 2) + "•".repeat(Math.max(2, String(c || "").length - 2));

// =========================================================
// 📘 생활 필수 표현 커리큘럼: 600개를 순서대로 하루 10개씩 음성으로 훑고, 모르는 것만 훈련 + 간격 복습
//  상태 S.cur.items[id] = { st: 'pass'(바로 말함) | 'train'(훈련 중) | 'learned'(익힘), box, due, first, n, at }
// =========================================================
const CUR_DAILY = 10, CUR_BACKLOG = 30, CUR_GAPS = [1, 3, 7, 14, 30];
const CUR_LIST = (() => { const out = []; (window.CURRICULUM || []).forEach((u, ui) => u.items.forEach((it, k) => out.push({ id: `${u.id}-${String(k + 1).padStart(2, "0")}`, ui, unit: u, e: it[0], k: it[1], x: it[2], n: it[3] || "" }))); return out; })();
const CUR_BY = new Map(CUR_LIST.map((x) => [x.id, x]));
const curSt = (id) => S.cur.items[id];
const curDueList = () => CUR_LIST.filter((x) => { const c = curSt(x.id); return c && c.st === "train" && (c.due || "") <= today(); });
const curNewToday = () => CUR_LIST.filter((x) => (curSt(x.id) || {}).first === today()).length;
const curQuota = () => CUR_DAILY * (1 + (S.cur.extra[today()] || 0));
const curNext = (n) => CUR_LIST.filter((x) => !curSt(x.id)).slice(0, n);
/* 🧩 오늘의 문법: 기본동사·5형식·시제·가정법 186문장을 단원 주제에 맞춰 나눠, 커리큘럼 안에서 하루 3문장씩 같이 훈련
 *  진도는 커리큘럼과 같은 S.cur.items 에 'g-…' id로 저장(같은 간격 복습). 결과는 훈련 탭 정답률(S.train)에도 반영 */
const UNIT_GRAM = { u01: ["tense:pres", "verb:get"], u02: ["verb:put", "form:1"], u03: ["tense:presprog", "verb:do"], u04: ["verb:make", "form:3"], u05: ["verb:have", "tense:past"],
  u06: ["verb:take", "form:2"], u07: ["tense:fut", "verb:go"], u08: ["verb:give", "form:4"], u09: ["tense:presperf"], u10: ["verb:keep", "form:5"], u11: ["tense:pastprog", "verb:let"],
  u12: ["tense:futprog"], u13: ["tense:presperfprog", "verb:come"], u14: ["tense:pastperf"], u15: ["tense:futperf"], u16: ["tense:subj2"], u17: ["verb:work", "tense:pastperfprog"],
  u18: ["tense:wish"], u19: ["tense:futperfprog"], u20: ["tense:subj3"], u22: ["tense:subjmix"] };
const GRAM_DAILY = 3;
const GRAM_SETS = (() => {
  const V = window.VERBS || [], F = window.FORMS || [], T = window.TENSES || [], units = window.CURRICULUM || [], out = [], seen = new Set();
  const make = (key, ui) => {
    if (seen.has(key)) return; const [kind, id] = key.split(":");
    const set = kind === "verb" ? V.find((x) => x.v === id) : kind === "form" ? F.find((x) => String(x.n) === id) : T.find((x) => x.id === id);
    if (!set) return; seen.add(key);
    const name = kind === "verb" ? `기본동사 ${set.v}` : kind === "form" ? set.name.split(" ")[0] : set.name;
    const rule = kind === "verb" ? set.core : kind === "form" ? set.name.replace(/^\d형식\s*/, "") : set.form;
    out.push({ key, kind, id, ui, name, rule, set });
  };
  units.forEach((u, ui) => (UNIT_GRAM[u.id] || []).forEach((k) => make(k, ui)));
  V.forEach((x) => make("verb:" + x.v, units.length - 1)); F.forEach((x) => make("form:" + x.n, units.length - 1)); T.forEach((x) => make("tense:" + x.id, units.length - 1));
  return out;
})();
const GRAM_LIST = GRAM_SETS.flatMap((g) => g.set.items.map((it, k) => ({ id: `g-${g.kind}-${g.id}-${k + 1}`, g: true, gs: g, gkey: g.key, ui: g.ui,
  unit: { t: "문법 · " + g.name }, e: it.en, k: it.ko, x: it.en, hl: it.hl || "",
  n: g.kind === "verb" ? (it.note || "") : g.kind === "form" ? (it.parts || "") : `${g.set.name}: ${g.set.form}` })));
const gramDueList = () => GRAM_LIST.filter((x) => { const c = curSt(x.id); return c && c.st === "train" && (c.due || "") <= today(); });
const gramNewToday = () => GRAM_LIST.filter((x) => (curSt(x.id) || {}).first === today()).length;
const gramQuota = () => GRAM_DAILY * (1 + (S.cur.extra[today()] || 0));
const gramNext = (n) => GRAM_LIST.filter((x) => !curSt(x.id)).slice(0, n);
const gramSeen = () => GRAM_LIST.filter((x) => curSt(x.id)).length;
/** 오늘 커리큘럼이 다루는 문법 세트(훈련 탭 기본 선택에도 씀) */
function gramToday() { const x = gramNext(1)[0] || GRAM_LIST.filter((y) => (curSt(y.id) || {}).first === today()).pop(); return x ? x.gs : null; }
function curStats() {
  let seen = 0, pass = 0, train = 0, learned = 0;
  for (const x of CUR_LIST) { const c = curSt(x.id); if (!c) continue; seen++; if (c.st === "pass") pass++; else if (c.st === "train") train++; else learned++; }
  return { seen, pass, train, learned, total: CUR_LIST.length };
}
/** 오늘 할 몫이 끝났나: 오늘 새 표현 몫(복습 밀림이 크면 0) + 오늘 복습 */
function curTodayLeft() {
  const due = curDueList().length, backlog = due > CUR_BACKLOG;
  const newLeft = backlog && S.cur.forceNew !== today() ? 0 : Math.max(0, Math.min(curQuota() - curNewToday(), CUR_LIST.length - curStats().seen));
  const gDue = Math.min(gramDueList().length, 10), gNew = backlog && S.cur.forceNew !== today() ? 0 : Math.max(0, Math.min(gramQuota() - gramNewToday(), GRAM_LIST.length - gramSeen()));
  return { due, newLeft, backlog, gDue, gNew, left: due + newLeft + gDue + gNew };
}
function curMark(x, ok) {
  const c = S.cur.items[x.id] || { first: today(), n: 0, box: 0 };
  c.n = (c.n || 0) + 1; c.at = new Date().toISOString();
  if (!c.st) { if (ok) { c.st = "pass"; } else { c.st = "train"; c.box = 0; c.due = addDays(today(), 1); } }
  else if (c.st === "train") {
    if (ok) { c.box = (c.box || 0) + 1; if (c.box >= CUR_GAPS.length) { c.st = "learned"; c.due = ""; } else c.due = addDays(today(), CUR_GAPS[c.box]); }
    else { c.box = 0; c.due = addDays(today(), 1); }
  } else if (!ok) { c.st = "train"; c.box = 0; c.due = today(); }   // 테스트에서 틀리면 다시 훈련
  S.cur.items[x.id] = c; log("cur");
  if (x.g) { const t = { ...(S.train[x.gkey] || { n: 0, ok: 0 }) }; t.n++; if (ok) t.ok++; t.at = today(); S.train[x.gkey] = t; log("drill"); }
  if (!ok) curToReview(x); else save();
}
function curToReview(x) {
  const existed = S.wrong.some((w) => !w.del && norm(w.en) === norm(x.e));
  addWrong({ ko: x.k, en: x.e, src: "커리큘럼 · " + x.unit.t }, "", { why: x.g ? `${x.gs.name} — ${x.gs.rule}${x.n ? " · " + x.n : ""}` : `예: ${x.x}${x.n ? " · " + x.n : ""}`, types: x.g && x.gs.kind === "tense" ? ["시제"] : [] });
  if (!existed) { const w = S.wrong.find((y) => norm(y.en) === norm(x.e)); if (w) w.natural = x.x; save(); }
}
const curHint = (e) => e.replace(/[A-Za-z']+/g, (w) => w[0] + "_".repeat(Math.max(1, w.length - 1)));
function curEta() {
  const left = CUR_LIST.length - curStats().seen; if (!left) return "완주!";
  const d = new Date(today() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + Math.ceil(left / CUR_DAILY) - (curNewToday() >= CUR_DAILY ? 0 : 1));
  return d.toISOString().slice(0, 10).slice(2).replace(/-/g, ".") + " 완주 예상";
}
function curHomeCard() {
  if (!CUR_LIST.length) return "";
  const st = curStats(), t = curTodayLeft(), next = curNext(1)[0], unit = next ? next.unit : CUR_LIST[CUR_LIST.length - 1].unit;
  const ui = next ? next.ui : (window.CURRICULUM.length - 1), inUnit = next ? CUR_LIST.filter((x) => x.ui === ui && curSt(x.id)).length : 25;
  const doneNew = curNewToday(), q = curQuota(), finished = t.left === 0;
  const testDue = curTestDue();
  return `<div class="card cur-card ${finished ? "done" : ""}">
    <div class="row spread"><b>📘 오늘의 커리큘럼</b><button class="lnk" data-cur-map>전체 지도 ›</button></div>
    <div class="cur-where">단원 ${ui + 1}/24 · <b>${esc(unit.t)}</b> <span class="muted">${inUnit}/25</span></div>
    <div class="cur-bar" title="전체 ${st.seen}/${st.total}"><i style="width:${(st.seen / st.total) * 100}%"></i></div>
    <div class="small muted">전체 ${st.seen}/${st.total} 훑음 · 바로 말함 ${st.pass} · 훈련 중 ${st.train} · 익힘 ${st.learned} · ${curEta()}</div>
    ${GRAM_LIST.length ? (() => { const g = gramToday(), gn = gramNewToday(); return `<div class="small cur-gram">🧩 문법 ${gramSeen()}/${GRAM_LIST.length} · 오늘 ${Math.min(gn, gramQuota())}/${gramQuota()}문장${t.gDue ? ` · 복습 ${t.gDue}` : ""}${g ? ` · <button class="lnk small" data-gram-open="${esc(g.key)}">${esc(g.name)}</button>` : ""}</div>`; })() : ""}
    <div class="cur-today">${finished ? `<b class="good">✓ 오늘 몫 끝!</b> 새 표현 ${doneNew}개 + 문법 ${gramNewToday()}문장${t.due ? "" : " · 복습 완료"}` : `오늘: 새 표현 <b>${Math.min(doneNew, q)}/${q}</b> + 문법 <b>${Math.min(gramNewToday(), gramQuota())}/${gramQuota()}</b>${t.due ? ` · 복습 <b>${t.due}</b>개` : ""}${t.backlog ? ' <span class="bad small">복습이 30개를 넘어 새 표현은 잠시 쉬어요</span>' : ""}`}</div>
    <div class="row" style="gap:6px;margin-top:8px">${finished ? `<button class="btn" data-cur-more>+10개 더 하기</button>` : `<button class="btn primary big" data-cur-go style="flex:1">${doneNew || st.seen ? "이어 하기" : "시작하기"} (${t.left}개)</button>`}
      ${testDue ? `<button class="btn" data-cur-test>📝 주간 테스트</button>` : ""}</div>
  </div>`;
}
function curBanner() {
  const t = curTodayLeft(); if (!CUR_LIST.length || t.left === 0) return "";
  return `<button class="cur-banner" data-cur-go>📘 오늘의 커리큘럼 ${t.left}개 남음 · 이어 하기 ›</button>`;
}
function curAfterRender(tab, v) {
  if (!CUR_LIST.length) return;
  if (tab === "home") v.insertAdjacentHTML("afterbegin", curHomeCard()); else { const b = curBanner(); if (b) v.insertAdjacentHTML("afterbegin", b); }
  v.querySelectorAll("[data-cur-go]").forEach((b) => (b.onclick = () => curSession()));
  v.querySelectorAll("[data-cur-map]").forEach((b) => (b.onclick = () => curMap()));
  v.querySelectorAll("[data-cur-test]").forEach((b) => (b.onclick = () => curTest()));
  v.querySelectorAll("[data-gram-open]").forEach((b) => (b.onclick = () => gramOpen(b.dataset.gramOpen)));
  v.querySelectorAll("[data-cur-more]").forEach((b) => (b.onclick = () => { S.cur.extra[today()] = (S.cur.extra[today()] || 0) + 1; save(); curSession(); }));
}
/** 한 번의 학습(복습 먼저, 그다음 새 표현). 표현마다: 한국어 뜻 → 🎙 영어로 말하기(음성 채점) → 정답·예문 → 모르면 훈련 2단계 */
function curSession(queueIn, title) {
  const t = curTodayLeft();
  let queue = queueIn;
  if (!queue) {   // 새 표현 사이에 오늘의 문법을 끼워 넣어 자연스럽게 같이 훈련
    const nw = curNext(t.newLeft).map((x) => ({ x, kind: "new" })), gn = gramNext(t.gNew).map((x) => ({ x, kind: "new" })), mix = [];
    const every = gn.length ? Math.max(2, Math.ceil(nw.length / (gn.length + 1))) : 0;
    nw.forEach((q, i) => { mix.push(q); if (every && (i + 1) % every === 0 && gn.length) mix.push(gn.shift()); });
    queue = [...curDueList().slice(0, 30).map((x) => ({ x, kind: "review" })), ...gramDueList().slice(0, 10).map((x) => ({ x, kind: "review" })), ...mix, ...gn];
  }
  if (!queue.length && !queueIn && t.backlog) { S.cur.forceNew = today(); queue = [...curNext(CUR_DAILY), ...gramNext(GRAM_DAILY)].map((x) => ({ x, kind: "new" })); }
  if (!queue.length) { toast("오늘 몫은 끝났어요. +10개 더 하기로 이어갈 수 있어요"); render(); return; }
  let i = 0; const res = { ok: 0, bad: 0 };
  openSheet(`<h2>📘 ${esc(title || "오늘의 커리큘럼")}</h2><div id="curBox"></div>`);
  const box = $("#curBox");
  const step = () => {
    if (i >= queue.length) return finish();
    const { x, kind } = queue[i];
    box.innerHTML = `<div class="cur-prog"><span>${i + 1}/${queue.length}</span><span class="muted">${x.g ? `🧩 ${kind === "review" ? "문법 복습" : "오늘의 문법"} · ${esc(x.gs.name)}` : kind === "review" ? "🔁 복습" : kind === "test" ? "📝 테스트" : `단원 ${x.ui + 1} · ${esc(x.unit.t)}`}</span></div>
      <div class="cur-q"><small class="muted">${x.g ? "문장 전체를 영어로 말해 보세요" : "영어로 말해 보세요"}</small><b>${esc(x.k)}</b>${x.g ? `<div class="gram-rule"><span class="tag">${esc(x.gs.name)}</span> ${esc(x.gs.rule)}</div>` : ""}</div>
      <div id="curHint" class="cur-hint" hidden>${esc(curHint(x.e))}</div>
      <div id="curOut" class="small" style="min-height:22px;margin:8px 0"></div>
      <div class="row" style="gap:6px"><button class="btn primary big" id="curMic" style="flex:1">🎙 말하기</button><button class="btn" id="curHintBtn">💡 힌트</button><button class="btn" id="curIdk">모르겠어요</button></div>
      <div id="curAns"></div>`;
    let tries = 0, settled = false, lastOk = null, prev = null;
    const reveal = (ok) => {
      if (settled) return; settled = true; lastOk = ok;
      prev = S.cur.items[x.id] ? JSON.parse(JSON.stringify(S.cur.items[x.id])) : null;
      if (kind !== "test") curMark(x, ok); else if (!ok) curMark(x, false);
      ok ? res.ok++ : res.bad++;
      $("#curMic").disabled = true; $("#curHintBtn").disabled = true; $("#curIdk").disabled = true;
      $("#curAns").innerHTML = `${x.g ? `<div class="cur-ans ${ok ? "ok" : "bad"}"><div class="small">${ok ? "✓ 맞았어요" : "이렇게 말해요"}</div><div class="en"><b>${tappable(x.e, x.hl)}</b></div><div class="acts">${sayBtns(x.e)}</div>${x.n ? `<div class="small muted">💡 ${esc(x.n)}</div>` : ""}
          <button class="lnk small" data-gram-open="${esc(x.gkey)}">${esc(x.gs.name)} 그림·예문 전체 보기 ›</button></div>`
        : `<div class="cur-ans ${ok ? "ok" : "bad"}"><div class="small">${ok ? "✓ 맞았어요" : "이렇게 말해요"}</div><b>${esc(x.e)}</b>
        <div class="en" style="margin-top:6px">${tappable(x.x, x.e)}</div><div class="acts">${sayBtns(x.x)}</div>${x.n ? `<div class="small muted">💡 ${esc(x.n)}</div>` : ""}</div>`}
        ${ok || kind === "test" ? `<button class="btn primary big" id="curNext" style="width:100%;margin-top:8px">다음 ›</button>${ok && kind === "new" ? '<button class="lnk small" id="curUnsure" style="margin-top:4px">사실 헷갈렸어요 → 훈련 목록에 넣기</button>' : ""}`
        : `<div class="cur-train"><b class="small">훈련 1/2 · 예문을 듣고 따라 말하기</b><div id="curT1" class="small" style="min-height:20px"></div>
           <div class="row" style="gap:6px"><button class="btn" id="curListen">🔊 듣기</button><button class="btn primary" id="curShadow" style="flex:1">🎙 따라 말하기</button></div>
           <div id="curT2wrap" hidden><b class="small">훈련 2/2 · 뜻만 보고 다시 말하기: ${esc(x.k)}${x.g ? ` (${esc(x.gs.rule)})` : ""}</b><div id="curT2" class="small" style="min-height:20px"></div><button class="btn primary" id="curAgain" style="width:100%">🎙 다시 말하기</button></div>
           <button class="btn" id="curNext" style="width:100%;margin-top:8px">다음 ›</button></div>`}`;
      speak(x.x);
      $("#curNext").onclick = () => { i++; step(); };
      const go2 = box.querySelector("[data-gram-open]"); if (go2) go2.onclick = () => gramOpen(go2.dataset.gramOpen);
      const un = $("#curUnsure"); if (un) un.onclick = () => { const c = S.cur.items[x.id]; c.st = "train"; c.box = 0; c.due = addDays(today(), 1); c.at = new Date().toISOString(); curToReview(x); un.outerHTML = '<span class="small muted">훈련 목록에 넣었어요 (내일 복습)</span>'; };
      if (!ok && kind !== "test") {
        $("#curListen").onclick = () => speak(x.x);
        $("#curShadow").onclick = async () => { const o = $("#curT1"); const r = await hearSentence(x.x, o); if (!r) return; o.innerHTML = `<span class="tag ${r.score >= 80 ? "good" : "bad"}">${r.score}%</span>${hearHtml(r)}`; if (r.score >= 80 || ++tries >= 2) $("#curT2wrap").hidden = false; };
        $("#curAgain").onclick = async () => { const o = $("#curT2"); const r = await hearSentence(x.e, o); if (!r) return; o.innerHTML = `<span class="tag ${r.score >= 80 ? "good" : "bad"}">${r.score}%</span> ${r.score >= 80 ? "좋아요! 내일 다시 물어볼게요." : "괜찮아요, 내일 복습에서 다시 해요."}${hearHtml(r)}`; };
      }
    };
    $("#curHintBtn").onclick = () => { $("#curHint").hidden = false; };
    $("#curIdk").onclick = () => reveal(false);
    $("#curMic").onclick = async () => {
      const o = $("#curOut"); const r = await hearSentence(x.e, o); if (!r) return;
      tries++;
      if (r.score >= 80) { o.innerHTML = `<span class="tag good">${r.score}%</span>${hearHtml(r)}`; reveal(true); return; }
      o.innerHTML = `<span class="tag bad">${r.score}%</span> ${tries < 2 ? "한 번 더 말해 보세요." : ""}${hearHtml(r)}<div class="row" style="gap:6px;margin-top:4px"><button class="lnk small" id="curSttOk">제대로 말했는데 잘못 들었어요 ✓</button></div>`;
      $("#curSttOk").onclick = () => {   // 음성 인식이 잘못 들은 경우: 방금 결과를 되돌리고 통과로
        if (!settled) return reveal(true);
        if (lastOk) return;
        if (prev) S.cur.items[x.id] = prev; else delete S.cur.items[x.id];
        { const w = S.wrong.find((y) => !y.del && norm(y.en) === norm(x.e) && (y.src || "").startsWith("커리큘럼") && !(y.reps > 0) && (y.at || "").slice(0, 10) === today()); if (w) S.wrong = S.wrong.filter((y) => y.id !== w.id); save(); }   // 잘못 들은 거라 복습함에서도 뺌
        res.bad--; settled = false; reveal(true); $("#curSttOk")?.remove();
      };
      if (tries >= 2) reveal(false);
    };
  };
  const finish = () => {
    const t2 = curTodayLeft();
    const gq = queue.filter((q) => q.x.g), gs = [...new Set(gq.map((q) => q.x.gs.name))];
    box.innerHTML = `<div class="result ok" style="text-align:center"><div class="score">${res.ok}/${queue.length}</div><p>${title ? "끝!" : "오늘 학습 끝!"} 바로 말한 표현 ${res.ok}개, 훈련한 표현 ${res.bad}개</p>${gq.length ? `<p class="small">🧩 오늘의 문법 ${gq.length}문장 · ${esc(gs.join(", "))}</p>` : ""}
      <p class="small muted">훈련한 표현은 1·3·7·14·30일 뒤에 다시 물어봐요.${t2.left ? ` 아직 ${t2.left}개 남았어요.` : ""}</p></div>
      <div class="row" style="gap:6px;margin-top:10px">${!queueIn && !t2.left ? '<button class="btn" id="curMore2">+10개 더</button>' : ""}<button class="btn primary big" id="curClose" style="flex:1">닫기</button></div>`;
    $("#curClose").onclick = () => { closeSheet(); render(); };
    const m2 = $("#curMore2"); if (m2) m2.onclick = () => { S.cur.extra[today()] = (S.cur.extra[today()] || 0) + 1; save(); curSession(); };
  };
  step();
}
/** 역할극 목표 표현 최대 3개: 복습이 다가온 훈련 표현 → 최근 7일에 처음 본 표현 (매번 조금씩 바뀌게 섞음) */
function gramOpen(key) {
  const [kind, id] = String(key).split(":"); if (!kind) return;
  trainMode = kind; if (kind === "verb") verbPick = id; else if (kind === "form") formPick = +id; else tensePick = id;
  closeSheet(); go("train");
}
function curRoleTargets() {
  if (!CUR_LIST.length || !S.cur) return [];
  const since = addDays(today(), -7), sh = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const train = CUR_LIST.filter((x) => (curSt(x.id) || {}).st === "train").sort((a, b) => (curSt(a.id).due || "").localeCompare(curSt(b.id).due || "")).slice(0, 6);
  const recent = CUR_LIST.filter((x) => { const c = curSt(x.id); return c && c.st !== "train" && (c.first || "") > since; });
  const out = []; for (const x of [...sh(train), ...sh(recent)]) { if (out.length >= 3) break; if (!out.some((y) => y.id === x.id)) out.push(x); }
  return out;
}
/** 문장에 표현을 썼나: someone·your 같은 자리 단어는 빼고, 남은 단어마다 앞 4글자가 순서대로 나오면(활용형 허용) */
function curUses(line, phrase) {
  const words = norm(line).split(/\s+/).filter(Boolean);
  const core = norm(phrase).split(/\s+/).filter((w) => w && !["someone", "your", "my", "the", "a", "an", "it's", "its"].includes(w));
  if (!core.length) return false;
  let i = 0;
  for (const w of core) { const k = w.slice(0, Math.min(4, w.length)); while (i < words.length && !words[i].startsWith(k)) i++; if (i >= words.length) return false; i++; }
  return true;
}
/** 주간 테스트: 지난 7일 동안 처음 본 표현 중 20개 무작위, 틀리면 다시 훈련 */
function curTestDue() {
  const since = addDays(today(), -7), pool = CUR_LIST.filter((x) => { const c = curSt(x.id); return c && (c.first || "") > since && c.first < today(); });
  return pool.length >= 10 && (S.cur.lastTest || "") <= since ? pool : null;
}
function curTest() {
  const pool = curTestDue() || []; if (!pool.length) return toast("이번 주 테스트할 표현이 아직 없어요");
  const pick = pool.slice().sort(() => Math.random() - 0.5).slice(0, 20);
  S.cur.lastTest = today(); S.cur.tests.push({ at: new Date().toISOString(), d: today(), n: pick.length }); save();
  curSession(pick.map((x) => ({ x, kind: "test" })), "주간 테스트");
}
function curMap() {
  const C = window.CURRICULUM || [], nx = curNext(1)[0];
  openSheet(`<h2>📘 커리큘럼 전체 지도</h2><p class="small muted">순서대로 하루 ${CUR_DAILY}개 + 문법 ${GRAM_DAILY}문장. 바로 말한 표현은 통과, 모르는 표현은 훈련 뒤 1·3·7·14·30일 간격으로 다시 물어봐요.</p>
    <div class="cur-gmap">${GRAM_SETS.map((g) => { const xs = GRAM_LIST.filter((x) => x.gkey === g.key), sn = xs.filter((x) => curSt(x.id)).length; return `<button class="chip ${sn === xs.length ? "on" : ""}" data-gram-open="${esc(g.key)}" title="단원 ${g.ui + 1}과 함께">${esc(g.name)} <small>${sn}/${xs.length}</small></button>`; }).join("")}</div>
    <div class="cur-map">${C.map((u, ui) => { const xs = CUR_LIST.filter((x) => x.ui === ui), c = (s) => xs.filter((x) => (curSt(x.id) || {}).st === s).length, seen = xs.filter((x) => curSt(x.id)).length;
      return `<details class="cur-unit ${nx && nx.ui === ui ? "now" : ""}"><summary><span>${ui + 1}. ${esc(u.t)}</span><span class="small muted">${seen}/25${c("train") ? ` · 훈련 ${c("train")}` : ""}</span><i class="cur-bar mini"><i style="width:${(seen / 25) * 100}%"></i></i></summary>
        <ul>${xs.map((x) => { const s2 = (curSt(x.id) || {}).st; return `<li class="${s2 || "new"}"><span>${s2 === "train" ? "🔁" : s2 === "learned" ? "⭐" : s2 === "pass" ? "✓" : "·"}</span> <b>${esc(x.e)}</b> <small class="muted">${esc(x.k)}</small> <button class="act" data-say="${esc(x.x)}">🔊</button></li>`; }).join("")}</ul></details>`; }).join("")}</div>
    <p class="small muted">✓ 바로 말함 · 🔁 훈련 중 · ⭐ 익힘(30일 간격까지 통과) · · 아직 안 봄</p>`);
}

function renderHome(v) {
  const h = todayH(), due = dueItems().length, sc = todayScenario(), ws = todayWriting();
  const wg = weeklyGoals();
  const speakN = Math.min(h.speak || 0, 12), writeN = Math.min(h.write || 0, 10), drillN = h.drill || 0;
  const days = [...Array(7)].map((_, k) => addDays(today(), k - 6));
  const tot = (d) => Object.values(S.history[d] || {}).reduce((a, b) => a + b, 0);
  const mx = Math.max(10, ...days.map(tot));
  const hour = +new Intl.DateTimeFormat("en-NZ", { hour: "numeric", hour12: false, timeZone: "Pacific/Auckland" }).format(new Date());
  const greet = hour < 12 ? "Morning! ☀️" : hour < 18 ? "Kia ora! 👋" : "Evening! 🌙";
  const totalSentences = Object.values(S.history).reduce((a, x) => a + (x.speak || 0) + (x.write || 0) + (x.drill || 0) + (x.review || 0) + (x.mono || 0) * 6, 0);
  const parts = [["speak", speakN / 12], ["mono", (h.mono || 0) ? 1 : 0], ["write", writeN / 10], ["train", Math.min(drillN / 10, 1)], ["vault", due ? 0 : 1]];
  const todayPct = Math.round((parts.reduce((a, [, x]) => a + x, 0) / parts.length) * 100), nextGo = (parts.find(([, x]) => x < 1) || [""])[0];
  // 아직 기록이 없는 통계 카드는 하나로 묶어 짧게 (기록이 생기면 각 카드로 나옴)
  const empty = { week: !Object.keys(S.history).some((d) => d >= addDays(today(), -13)), review: !S.wrong.some((w) => !w.del), weak: !S.errors.some((e) => (e.d || "") >= addDays(today(), -30)),
    speak: !Object.keys(S.speak).length, mono: !S.monoLog.length };
  const EMPTY_NAME = { week: "주간 리포트", review: "복습 성과", weak: "내 약점 TOP 3", speak: "말하기 기록", mono: "독백 낭독 기록" };
  const emptyKeys = Object.keys(empty).filter((k) => empty[k]);
  const statCard = (k, html) => (empty[k] ? "" : html);
  v.innerHTML = `
    <div class="hello"><h2>${greet}</h2><p class="muted" style="margin:2px 0 0">오늘도 짧게, 소리 내서.</p></div>
    <div class="stats" style="margin-top:12px">
      <div class="stat"><b>🔥 ${streak()}</b><span>연속 학습일</span></div>
      <div class="stat"><b>${totalSentences}</b><span>누적 연습 문장</span></div>
      <button class="stat stat-link" data-go-saved aria-label="저장 문장 보기"><b>${S.saved.length}</b><span>저장 문장 ›</span></button>
    </div>
    <div class="card">
      <div class="row spread"><h3>오늘의 할 일</h3><span class="small muted">${todayPct}% 완료</span></div>
      <div class="dayprog" role="progressbar" aria-valuenow="${todayPct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${todayPct}%"></i></div>
      <div class="task" data-go="speak"><div class="ring" style="--p:${(speakN / 12) * 100}">${speakN}/12</div><div class="t"><b>스피킹 12문장</b><span>${esc(sc.title)}</span></div>›</div>
      <div class="task" data-go="mono"><div class="ring" style="--p:${(h.mono || 0) ? 100 : 0}">${(h.mono || 0) ? "✓" : "0/1"}</div><div class="t"><b>독백 낭독 1개</b><span>${esc(todayMono()?.title || "")} · 30~60초 소리 내 읽기${monoStreak() ? ` · 🔥${monoStreak()}일째` : ""}</span></div>›</div>
      <div class="task" data-go="write"><div class="ring" style="--p:${(writeN / 10) * 100}">${writeN}/10</div><div class="t"><b>영작 10문장</b><span>${esc(ws.title)}</span></div>›</div>
      <div class="task" data-go="train"><div class="ring" style="--p:${Math.min(drillN / 10, 1) * 100}">${drillN}</div><div class="t"><b>기본동사 · 5형식</b><span>오늘 ${drillN}문장 · 목표 10</span></div>›</div>
      <div class="task" data-go="vault"><div class="ring" style="--p:${due ? 0 : 100}">${due}</div><div class="t"><b>복습</b><span>${due ? `오늘 다시 볼 문장 ${due}개` : "오늘 복습 끝! 👍"}</span></div>›</div>
    </div>
    <div class="card">
      <div class="row spread"><h3>이번 주 목표</h3><span class="small muted">월~일</span></div>
      <div class="grid3" style="margin-top:10px">
        <div class="goal"><div class="ring" style="--p:${Math.min(wg.speak / 3, 1) * 100}">${wg.speak}/3</div><span>스피킹 3세트</span></div>
        <div class="goal"><div class="ring" style="--p:${Math.min(wg.write / 3, 1) * 100}">${wg.write}/3</div><span>영작 3세트</span></div>
        <div class="goal"><div class="ring" style="--p:${due ? 0 : 100}">${due}</div><span>복습 0개 유지</span></div>
      </div>
    </div>
    ${statCard("week", `<div class="card"><div class="row spread"><h3>주간 리포트</h3><span class="small muted">${esc(addDays(today(), -6).slice(5).replace("-", "/"))}~${esc(today().slice(5).replace("-", "/"))}</span></div>${weeklyReportHtml()}</div>`)}
    ${statCard("review", `<div class="card"><div class="row spread"><h3>복습 성과</h3><button class="btn sm" data-go="vault">복습하기</button></div>${reviewStatsHtml()}</div>`)}
    ${statCard("weak", `<div class="card"><h3>내 약점 TOP 3</h3>${weaknessHtml()}</div><div class="card"><div class="row spread"><h3>이번 주 약점 맞춤 연습</h3><span class="small muted">매주 월요일 새로</span></div>${weeklyWeakHtml()}</div>`)}
    ${statCard("speak", `<div class="card"><div class="row spread"><h3>말하기 기록</h3><button class="btn sm" id="goSpeakRec">문장별 보기</button></div>${speakStatsHtml()}</div>`)}
    ${statCard("mono", `<div class="card"><div class="row spread"><h3>독백 낭독 기록</h3><button class="btn sm" data-go="mono">낭독하기</button></div>${monoStatsHtml()}</div>`)}
    ${emptyKeys.length ? `<div class="card soon-card"><h3>📈 연습하면 여기에 쌓여요</h3><div class="chips" style="margin-top:6px">${emptyKeys.map((k) => `<span class="chip ghost">${EMPTY_NAME[k]}</span>`).join("")}</div>
      <p class="small muted" style="margin:6px 0 0">스피킹·영작·독백을 하면 진행 그래프, 복습 정답률, 자주 틀리는 유형이 하나씩 열려요.</p></div>` : ""}
    <div class="card"><h3>학습 달력 <small class="muted">최근 12주</small></h3>${heatmapHtml()}</div>
    <div class="card">
      <h3>이 말, 영어로 뭐라고 하지?</h3>
      <p class="small muted" style="margin:4px 0 8px">한국어를 쓰면 원어민 말투로 바꿔 드려요.</p>
      <div class="row"><input class="text" id="qConv" placeholder="예: 우리 애가 오늘 좀 피곤해 보여요"><button class="btn primary" id="qConvGo">변환</button></div>
    </div>`;
  v.querySelectorAll("[data-go]").forEach((t) => (t.onclick = () => go(t.dataset.go)));
  { const nx = nextGo && v.querySelector(`.task[data-go="${nextGo}"]`); if (nx) { nx.classList.add("next"); nx.querySelector(".t b").insertAdjacentHTML("beforeend", ' <span class="nexttag">다음</span>'); } }
  v.querySelectorAll("[data-weak]").forEach((b) => (b.onclick = () => weakPractice(b.dataset.weak)));
  if ($("#wkSetGo")) $("#wkSetGo").onclick = () => runWeeklyWeak(v);
  const gsr = $("#goSpeakRec"); if (gsr) gsr.onclick = () => { vaultMode = "speakrec"; go("vault"); };
  v.querySelector("[data-go-saved]").onclick = () => { vaultMode = "saved"; vaultQ = ""; go("vault"); };
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
    <div class="card"><div class="row spread"><h3>🎭 AI와 역할극</h3><span class="small muted">말하면 대답해요</span></div>
      <p class="small muted" style="margin:4px 0 8px">대본 없이 실제 대화처럼: AI가 <b>${esc(sc.roles?.B || "상대")}</b> 역할을 맡고, 내가 말한 문장은 바로 고쳐 줘요.</p>
      <div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn primary" id="rpGo">이 상황으로 시작</button><button class="btn" id="rpCustom">다른 상황 입력</button></div></div>
    <div class="card" id="rtnCard">
      <div class="row spread"><h3>🎧 받아쓰기 연습</h3><span class="small muted">듣고 → 쓰고 → 말하고 → 영작</span></div>
      <p class="small muted" style="margin:4px 0 8px">같은 문장을 <b>받아쓰기 → 따라 말하기 → 영작</b> 세 방식으로 꺼내 쓰면 훨씬 오래 남아요. 문장 수를 골라 시작하세요.</p>
      <div class="grid2"><button class="btn primary" data-rtn="4">3단 루틴 · 4문장</button><button class="btn" data-rtn="12">3단 루틴 · 전체 12</button><button class="btn" data-dict="6">받아쓰기만 · 6문장</button><button class="btn" data-dict="12">받아쓰기만 · 전체</button></div>
    </div>
    <div class="dlg" id="dlg"></div>
    <div class="sticky-actions">
      <button class="btn" id="playAll">▶ 전체 듣기</button>
      <button class="btn" id="saveScn">${savedScn ? "★ 보관됨" : "☆ 시나리오 보관"}</button>
      <button class="btn primary" id="doneScn">${S.done[doneKey] ? "✓ 오늘 완료" : "완료 기록"}</button>
    </div>`;
  $("#rpGo").onclick = () => startRoleplay(sc);
  $("#rpCustom").onclick = () => { const t = prompt("어떤 상황인가요? (예: 이웃에게 울타리 수리비 나누자고 말하기)"); if (t && t.trim()) startRoleplay(sc, t.trim().slice(0, 200)); };
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
      ${!hide && ln.key ? `<div class="keybox"><b>${esc(ln.key)}</b> — ${esc(ln.keyKo || "")} ${ygBtn(ln.key)}</div>` : ""}
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
        const r = await hearSentence(sc.lines[i].en, out); if (!r) return;
        const best = [r.text, r.score], rec = recordSpeak(sc, i, r.score);
        out.innerHTML = `<span class="tag ${r.score >= 80 ? "good" : "bad"}">${r.score}%</span> <span class="small muted">최고 ${rec.best}% · ${rec.n}회</span>${hearHtml(r)}`;
        if (best[1] >= 80) { log("shadow"); if (sc.lines[i].key) exprMark(sc.lines[i].key, sc.lines[i].keyKo, "spoken"); } else toast("복습함에 저장했어요. 천천히 한 단어씩 또박또박 다시 해 보세요");
        shadowResult(sc.lines[i], r, "따라 말하기 · " + sc.title.split(" — ")[0]);
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
  const startRtn = (n, mode) => {
    const today_ = today();
    let idxs = sc.lines.map((_, i) => i).filter((i) => !S.done[`routine:${today_}:${sc.id}:${i}`]);   // 오늘 루틴을 마치지 않은 문장 먼저
    if (idxs.length < n) idxs = sc.lines.map((_, i) => i);
    idxs = (n >= 12 ? idxs : idxs.sort(() => Math.random() - 0.5).slice(0, n)).sort((a, b) => a - b);
    const items = idxs.map((i) => ({ en: sc.lines[i].en, ko: sc.lines[i].ko, key: sc.lines[i].key, keyKo: sc.lines[i].keyKo, sc, idx: i, rkey: `routine:${today_}:${sc.id}:${i}`, src: (mode === "dict" ? "받아쓰기 " : "루틴 ") + sc.title }));
    $("#dlg").hidden = true; document.querySelector(".sticky-actions").hidden = true;
    const card = $("#rtnCard"); card.innerHTML = "";
    runRoutine(card, items, { mode, onFinish: () => renderSpeak(v) });
    window.scrollTo(0, 0);
  };
  v.querySelectorAll("[data-rtn]").forEach((b) => (b.onclick = () => startRtn(+b.dataset.rtn, "routine")));
  v.querySelectorAll("[data-dict]").forEach((b) => (b.onclick = () => startRtn(+b.dataset.dict, "dict")));
  $("#doneScn").onclick = () => {
    if (S.done[doneKey]) { toast("오늘 이미 기록했어요. 한 번 더 들어도 좋아요!"); return; }
    S.done[doneKey] = 1; S.done["speak:done:" + sc.id] = today(); log("speak", 12); toast("스피킹 12문장 완료! 🔥"); renderSpeak(v);
  };
}

// ── 받아쓰기 · 3단 루틴 (듣고 쓰기 → 따라 말하기 → 영작) ─────────
const FUNC_WORDS = new Set("a an the to of in on at for from with and or but so is are was were be been am do does did have has had will would can could should it its this that these those i you he she we they me him her us them my your his our their there here as if not no".split(" "));
// 받아쓰기 채점: 정답 단어 하나하나가 맞았는지(순서 유지, LCS) 표시
function dictDiff(exp, got) {
  const ew = exp.split(/\s+/).filter(Boolean), gw = got.split(/\s+/).filter(Boolean).map(norm);
  const en = ew.map(norm), m = en.length, n = gw.length;
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = en[i] === gw[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ok = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < m && j < n) { if (en[i] === gw[j]) { ok[i] = true; i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  const score = m ? Math.round((ok.filter(Boolean).length / m) * 100) : 0;
  return { words: ew.map((w, k) => ({ w, ok: ok[k] })), score };
}
const hintText = (en) => en.split(/\s+/).map((w) => w[0] + "·".repeat(Math.max(0, w.replace(/[^A-Za-z0-9']/g, "").length - 1))).join(" ");

// 한 문장 받아쓰기. onNext(result) 로 다음 단계에 넘김
function dictOne(box, it, head, onNext) {
  let tries = 0, hinted = false;
  box.innerHTML = `${head}
    <div class="dict-top"><button class="btn primary" id="dPlay">🔊 듣기 (10번)</button><button class="btn" id="dSlow">🐢 느리게</button><button class="btn" id="dUk">🇬🇧 영국</button><button class="btn ghost" id="dHint">힌트</button></div>
    <p class="small muted" style="margin:8px 0">들리는 대로 영어로 쓰세요. 마침표·대소문자는 채점에 영향이 없어요.</p>
    <textarea id="dIn" rows="3" placeholder="들은 문장을 쓰세요" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea>
    <div id="dHintOut" class="small muted" style="margin-top:6px"></div>
    <div class="row" style="margin-top:8px"><button class="btn ghost" id="dGive">모르겠어요</button><button class="btn primary" id="dGo" style="flex:1">확인</button></div><div id="dRes"></div>`;
  // 듣기는 기본 10번 반복(사이 1.5초 쉬며 쓰기). 멈춤 버튼·확인·모르겠어요·다음 문제·창 닫기 때만 멈춤
  const LOOP_N = 10, GAP = 1500; let loopGen = 0, looping = false;
  const gone = () => !box.isConnected || box.offsetParent === null;
  const updBtn = (k) => { const b = $("#dPlay", box); if (b) b.textContent = looping ? `■ 멈춤 (${k}/${LOOP_N})` : "🔊 듣기 (10번)"; };
  const stopLoop = () => { if (!looping) return; loopGen++; looping = false; window.speechSynthesis?.cancel(); updBtn(); };
  const play = async (slow, lang) => {
    const my = ++loopGen; looping = true;
    for (let k = 1; k <= LOOP_N; k++) {
      if (my !== loopGen || gone()) { if (my === loopGen) looping = false; return; }
      updBtn(k);
      await speak(it.en, lang, slow ? 0.7 : undefined);
      if (my !== loopGen) return;
      if (k < LOOP_N) await sleep(GAP);
    }
    if (my === loopGen) { looping = false; updBtn(); }
  };
  $("#dPlay", box).onclick = () => (looping ? stopLoop() : play(false)); $("#dSlow", box).onclick = () => play(true); $("#dUk", box).onclick = () => play(false, "en-GB");
  $("#dHint", box).onclick = () => { hinted = true; $("#dHintOut", box).textContent = "힌트: " + hintText(it.en); };
  const inp = $("#dIn", box); inp.focus({ preventScroll: true });
  setTimeout(() => play(false), 300);
  const judge = (giveUp) => {
    const got = giveUp ? "" : inp.value.trim();
    if (!giveUp && !got) return inp.focus();
    stopLoop();
    tries++;
    const d = dictDiff(it.en, got), pass = d.score >= 90 && !giveUp;
    const missed = d.words.filter((x) => !x.ok).map((x) => x.w.replace(/[^A-Za-z0-9']/g, "").toLowerCase());
    const fw = missed.filter((w) => FUNC_WORDS.has(w));
    $("#dRes", box).innerHTML = `<div class="result ${pass ? "ok" : "no"}">
      <div class="row spread"><span class="score">${pass ? "👍" : "🎧"} ${giveUp ? "" : d.score + "%"}</span><span class="tag ${pass ? "good" : "bad"}">${pass ? "통과" : "복습함에 저장"}</span></div>
      <div class="dict-ans">${d.words.map((x) => `<span class="${x.ok ? "dw-ok" : "dw-no"}">${esc(x.w)}</span>`).join(" ")}</div>
      ${got && !pass ? `<div class="small muted" style="margin-top:6px">내가 쓴 것: ${esc(got)}</div>` : ""}
      ${fw.length ? `<p class="small" style="margin:8px 0 0">작은 단어 <b>${esc([...new Set(fw)].join(", "))}</b>는 약하게 들려서 놓치기 쉬워요. 문장 리듬을 타고 들어 보세요.</p>` : ""}
      <div class="ko" style="margin-top:6px">${esc(it.ko || "")}</div>
      <div class="acts">${sayBtns(it.en)}</div></div>
      <div class="row" style="margin-top:10px">${!pass && !giveUp && tries < 3 ? `<button class="btn" id="dRetry">다시 써 보기</button>` : ""}<button class="btn primary big" id="dNext">다음 단계 →</button></div>`;
    ["#dGo", "#dGive"].forEach((q) => ($(q, box).disabled = true));
    if ($("#dRetry", box)) $("#dRetry", box).onclick = () => { $("#dRes", box).innerHTML = ""; ["#dGo", "#dGive"].forEach((q) => ($(q, box).disabled = false)); inp.focus(); };
    $("#dNext", box).onclick = () => {
      if (!pass) addWrong({ ko: it.ko || "", en: it.en, src: it.src || "받아쓰기" }, got, { why: giveUp ? "받아쓰기를 건너뜀" : `받아쓰기 ${d.score}% — 놓친 단어: ${missed.join(", ")}`, natural: it.en, types: [] });
      else if (it.key) exprMark(it.key, it.keyKo, "dict");
      log("dictation");
      onNext({ pass, score: d.score, hinted });
    };
  };
  $("#dGo", box).onclick = () => judge(false); $("#dGive", box).onclick = () => judge(true);
  inp.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#dGo", box).click(); } };
}

// 한 문장 따라 말하기
function shadowOne(box, it, head, sc, idx, onNext) {
  box.innerHTML = `${head}
    <div class="card tight"><div class="en">${tappable(it.en, it.key)}</div><div class="ko">${esc(it.ko || "")}</div></div>
    <div class="row wrap" style="margin-top:8px"><button class="btn" id="sPlay">🔊 듣기</button><button class="btn" id="sSlow">🐢 느리게</button><button class="btn primary" id="sMic" style="flex:1">🎙 따라 말하기</button></div>
    <div id="sRes" class="shadow-res" style="margin-top:8px"></div>
    <div class="row" style="margin-top:10px"><button class="btn primary big" id="sNext">다음 단계 →</button></div>`;
  let best = 0, bestR = null;
  $("#sPlay", box).onclick = () => speak(it.en); $("#sSlow", box).onclick = () => speak(it.en, undefined, 0.7);
  $("#sMic", box).onclick = async () => {
    const out = $("#sRes", box); out.innerHTML = '<span class="spinner"></span> 말해 보세요…';
    try {
      const r = await hearSentence(it.en, out); if (!r) return;
      const score = r.score; if (score >= best) bestR = r; best = Math.max(best, score);
      out.innerHTML = `<span class="tag ${score >= 80 ? "good" : "bad"}">${score}%</span> ${score >= 80 ? "좋아요! 👏" : "빨간 단어를 들어 보고 다시 해 보세요"}${hearHtml(r)}`;
      if (sc && idx != null) recordSpeak(sc, idx, score);
      if (score >= 80) { log("shadow"); if (it.key) exprMark(it.key, it.keyKo, "spoken"); }
    } catch (e) { out.textContent = e.message; }
  };
  $("#sNext", box).onclick = () => { if (bestR && best < 80) shadowResult(it, bestR, it.src || "루틴 따라 말하기"); onNext({ score: best }); };
}

// 받아쓰기 → 따라 말하기 → 영작 (문장마다 3단계). mode "dict" 이면 받아쓰기만
function runRoutine(box, items, opts = {}) {
  const res = [], total = items.length, dictOnly = opts.mode === "dict";
  const dots = (st) => (dictOnly ? "" : `<div class="steps3">${["① 받아쓰기", "② 따라 말하기", "③ 영작"].map((l, k) => `<span class="${k === st ? "cur" : k < st ? "done" : ""}">${l}</span>`).join("")}</div>`);
  const headOf = (n, st) => `<div class="row spread small muted"><span>${n + 1} / ${total}</span><span>${dictOnly ? "받아쓰기" : "3단 루틴"}</span></div><div class="quiz-prog"><i style="width:${(n / total) * 100}%"></i></div>${dots(st)}`;
  const finish = () => {
    const dp = res.filter((r) => r.dict && r.dict.pass).length, sp = res.filter((r) => r.shadow && r.shadow.score >= 80).length, wp = res.filter((r) => r.write).length;
    log(dictOnly ? "dictation_set" : "routine");
    box.innerHTML = `<div class="result ok" style="text-align:center"><div class="score">🎧 ${dp}/${total}</div><p>받아쓰기 통과 ${dp}/${total}${dictOnly ? "" : ` · 따라 말하기 80%↑ ${sp}/${total} · 영작 통과 ${wp}/${total}`}</p><p class="small muted">틀린 문장은 복습함에 들어갔어요. 간격 복습으로 다시 만나요.</p></div>
      <button class="btn primary big" id="rtnDone" style="margin-top:10px">${opts.doneLabel || "마치기"}</button>`;
    $("#rtnDone", box).onclick = () => opts.onFinish?.();
  };
  const item = (n) => {
    if (n >= total) return finish();
    const it = items[n], r = (res[n] = {});
    dictOne(box, it, headOf(n, 0), (d) => {
      r.dict = d;
      if (dictOnly) return item(n + 1);
      shadowOne(box, it, headOf(n, 1), it.sc, it.idx, (sh) => {
        r.shadow = sh;
        if (!it.ko) { return item(n + 1); }
        box.innerHTML = headOf(n, 2) + '<div id="rqz"></div>';
        quiz($("#rqz", box), [{ ko: it.ko, en: it.en, hint: it.key ? "핵심 표현: " + it.key : "" }], { kind: "routine_w", compact: true, src: it.src || "루틴", noSummary: true, onDone: (ok) => { r.write = ok > 0; if (it.rkey) { S.done[it.rkey] = 1; save(); } item(n + 1); } });
      });
    });
  };
  item(0);
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

// 훈련: 기본동사 · 5형식 · 시제
let trainMode = "verb", verbPick = null, formPick = null, tensePick = null;
const ROLE = { S: "주어", V: "동사", O: "목적어", C: "보어", IO: "~에게", DO: "~을/를", OC: "목적격 보어" };
function parseParts(p) {
  return (p || "").split("|").map((x) => { const t = x.match(/\(([^)]*)\)\s*$/); return { w: x.replace(/\([^)]*\)\s*$/, "").replace(/[()]/g, "").trim(), tag: t ? t[1] : "" }; }).filter((x) => x.w);
}
// 예문 성분 블록: 단어 덩어리 위, 역할 이름 아래
function partsHtml(p) {
  const segs = parseParts(p); if (!segs.length) return "";
  return `<div class="pblocks">${segs.map((x) => `<span class="pb ${/^(S|V|O|C|IO|DO|OC)$/.test(x.tag) ? x.tag : "X"}"><b>${esc(x.w)}</b><i>${esc(ROLE[x.tag] || x.tag || "")}</i></span>`).join("")}</div>`;
}
// 5형식 구조 그림: 성분 블록 + 관계(=, →)
function formDiagram(n) {
  const B = (t) => `<span class="fb ${t}"><b>${t}</b><i>${ROLE[t]}</i></span>`;
  const rows = {
    1: [B("S") + B("V") + `<span class="fb X"><b>+</b><i>장소·시간</i></span>`, "주어와 동사만으로 문장이 끝나요. 뒤는 꾸밈말이에요."],
    2: [B("S") + B("V") + B("C"), "S = C — 보어가 주어를 설명해요 (You look tired: you = tired)."],
    3: [B("S") + B("V") + B("O"), "동사가 목적어 하나를 받아요 (무엇을)."],
    4: [B("S") + B("V") + B("IO") + `<span class="rel">→</span>` + B("DO"), "누구에게(IO) 무엇을(DO) — 주다·보내다·보여 주다 류 동사."],
    5: [B("S") + B("V") + B("O") + B("OC"), "O = OC — 목적격 보어가 목적어의 상태·행동을 설명해요 (made me happy: me = happy)."],
  }[n];
  return `<div class="fdiag">${rows[0]}</div><p class="small muted" style="margin:6px 0 0">${esc(rows[1])}</p>`;
}
// 기본동사 의미 지도: 핵심 이미지에서 뜻이 가지 치는 그림
function verbMap(set, items) {
  const label = (it) => { const n = it.note || ""; const m = n.match(/:\s*(.+)$/) || n.match(/=\s*(.+)$/); return (m ? m[1] : n).replace(/\(.*?\)/g, "").trim() || it.ko; };
  const head = (it) => { const m = (it.note || "").match(/^([A-Za-z' +.]+?)\s*[:=]/); return m ? m[1].trim() : ""; };
  return `<div class="vmap"><div class="vcenter"><b>${esc(set.v)}</b><span>${esc(set.core)}</span></div>
    <div class="vbranches">${items.map((it, i) => `<a class="vbr" href="#ex-${i}" data-ex="${i}"><b>${esc(label(it))}</b>${head(it) ? `<span>${esc(head(it))}</span>` : ""}</a>`).join("")}</div></div>`;
}
// 시제 타임라인 (0~100, 지금 = 50)
function timelineSvg(tl) {
  const X = (v) => 14 + v * 2.92, Y = 66;
  const bars = (tl.bars || []).map(([a, b, k]) => k === "d"
    ? `<rect x="${X(a)}" y="${Y - 8}" width="${X(b) - X(a)}" height="16" rx="5" fill="none" stroke="var(--warn)" stroke-width="2" stroke-dasharray="5 4"/><text x="${(X(a) + X(b)) / 2}" y="${Y + 4}" text-anchor="middle" font-size="11" fill="var(--warn)" font-weight="700">상상</text>`
    : `<rect x="${X(a)}" y="${Y - 6}" width="${X(b) - X(a)}" height="12" rx="4" fill="${k === "p" ? "url(#stripe)" : "var(--accent)"}" stroke="var(--accent)" stroke-width="1.5"/>${k === "s" ? `<path d="M${X(b) - 2} ${Y - 9} L${X(b) + 6} ${Y} L${X(b) - 2} ${Y + 9}" fill="var(--accent)"/>` : ""}`).join("");
  const dots = (tl.dots || []).map((d) => `<circle cx="${X(d)}" cy="${Y}" r="${(tl.dots || []).length > 2 ? 5 : 7}" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`).join("");
  const refs = (tl.refs || []).map(([x, l]) => `<path d="M${X(x)} ${Y - 26} L${X(x) - 5} ${Y - 34} L${X(x) + 5} ${Y - 34} Z" fill="var(--text)"/><text x="${X(x)}" y="${Y - 38}" text-anchor="middle" font-size="11" fill="var(--text)" font-weight="700">${esc(l)}</text>`).join("");
  return `<svg class="tl" viewBox="0 0 320 100" role="img" aria-label="시제 타임라인">
    <defs><pattern id="stripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--accent-soft)"/><rect width="3" height="6" fill="var(--accent)"/></pattern></defs>
    <line x1="10" y1="${Y}" x2="306" y2="${Y}" stroke="var(--line)" stroke-width="3"/><path d="M306 ${Y - 5} L314 ${Y} L306 ${Y + 5} Z" fill="var(--line)"/>
    <line x1="${X(50)}" y1="${Y - 22}" x2="${X(50)}" y2="${Y + 18}" stroke="var(--muted)" stroke-dasharray="3 3"/>
    ${bars}${dots}${refs}
    <text x="${X(12)}" y="97" text-anchor="middle" font-size="11" fill="var(--muted)">과거</text><text x="${X(50)}" y="97" text-anchor="middle" font-size="11" fill="var(--muted)">지금</text><text x="${X(88)}" y="97" text-anchor="middle" font-size="11" fill="var(--muted)">미래</text>
    ${tl.label ? `<text x="10" y="13" font-size="11" fill="var(--muted)">${esc(tl.label)}</text>` : ""}</svg>`;
}
// 숙련도: 훈련 퀴즈 정답률
const trainStat = (key) => S.train[key] || { n: 0, ok: 0 };
function trainChip(key, label, on) {
  const t = trainStat(key), acc = t.n ? Math.round((t.ok / t.n) * 100) : -1;
  return `<button class="chip trc ${on ? "on" : ""} ${t.n >= 3 && acc < 60 ? "weak" : ""}" data-k="${esc(key.split(":")[1])}" title="${t.n ? `정답률 ${acc}% · ${t.n}문장` : "아직 연습 전"}"><span>${esc(label)}</span><i style="--w:${Math.max(0, acc)}%"></i></button>`;
}
function renderTrain(v) {
  { const g = gramToday(); if (g && !renderTrain.init) { renderTrain.init = 1; trainMode = g.kind; if (g.kind === "verb") verbPick = g.id; else if (g.kind === "form") formPick = +g.id; else tensePick = g.id; } }
  verbPick = verbPick || VERBS[dayNum(today()) % VERBS.length].v;
  formPick = formPick || (dayNum(today()) % 5) + 1;
  tensePick = tensePick || TENSES[dayNum(today()) % TENSES.length].id;
  const mode = trainMode, isVerb = mode === "verb", isTense = mode === "tense";
  const set = isVerb ? VERBS.find((x) => x.v === verbPick) : isTense ? TENSES.find((t) => t.id === tensePick) : FORMS.find((f) => f.n === formPick);
  const key = isVerb ? "verb:" + set.v : isTense ? "tense:" + set.id : "form:" + set.n;
  // YouGlish 검색어: 동사는 메모의 숙어("have a word")·없으면 동사 자체, 5형식은 동사+뒤 한 덩어리("made me"), 시제는 시제 부분("I've lived")
  const ygPhraseOf = (it) => {
    if (isTense) return it.hl || it.en;
    if (isVerb) { const m = (it.note || "").match(/^([A-Za-z' ]+?)\s*:/); return m ? m[1].trim() : set.v; }
    const segs = parseParts(it.parts), vi = segs.findIndex((x) => x.tag === "V");
    return vi >= 0 ? [segs[vi].w, segs[vi + 1] ? segs[vi + 1].w : ""].join(" ").trim() : it.en;
  };
  const extraKey = key;
  const FT = { 1: "S,V", 2: "S,V,C", 3: "S,V,O", 4: "S,V,IO,DO", 5: "S,V,O,OC" };
  const extra = (S.done["ai:" + extraKey] || []).filter((it) => mode !== "form" || parseParts(it.parts).map((x) => x.tag.toUpperCase()).filter((t) => /^(S|V|O|C|IO|DO|OC)$/.test(t)).join(",") === FT[set.n]);   // 예전에 형식이 안 맞게 만들어진 AI 문장은 숨김
  const items = [...set.items, ...extra];
  const st = trainStat(key), acc = st.n ? Math.round((st.ok / st.n) * 100) : null;
  const chips = isVerb ? VERBS.map((x) => trainChip("verb:" + x.v, x.v, x.v === verbPick)).join("")
    : isTense ? ["시제", "가정법"].map((g) => `<span class="chip-g">${g}</span>` + TENSES.filter((t) => t.group === g).map((t) => trainChip("tense:" + t.id, t.name, t.id === tensePick)).join("")).join("")
    : FORMS.map((f) => trainChip("form:" + f.n, f.n + "형식", f.n === formPick)).join("");
  const visual = isVerb ? verbMap(set, set.items) : isTense ? `${timelineSvg(set.tl)}<div class="tform"><span class="tag">${esc(set.form)}</span></div><p class="small" style="margin:6px 0 0"><b>언제?</b> ${esc(set.use)}</p><p class="small muted" style="margin:4px 0 0">💡 ${esc(set.tip)}</p>` : formDiagram(set.n);
  v.innerHTML = `
    <div class="seg" id="trSeg"><button data-m="verb">기본동사</button><button data-m="form">5형식</button><button data-m="tense">시제·가정법</button></div>
    <div class="chips trchips ${isTense ? "wrap2" : ""}" id="trChips">${chips}</div>
    <div class="card">
      <div class="row spread"><h2>${esc(isVerb ? set.v : set.name)}</h2>${acc !== null ? `<span class="tag ${acc >= 80 ? "good" : acc < 60 ? "bad" : ""}">정답률 ${acc}% · ${st.n}문장</span>` : `<span class="small muted">아직 연습 전</span>`}</div>
      ${isTense ? (set.ko.replace(/\s/g, "") === set.name.replace(/\s/g, "") ? "" : `<p class="verb-core">${esc(set.ko)}</p>`) : `<p class="verb-core">${esc(isVerb ? "핵심 이미지: " + set.core : set.desc)}</p>`}
      ${isVerb ? `<div class="row wrap" style="margin-top:6px">${sayBtns(set.v)}<a class="act yg" href="${ygUrl(set.v)}" target="_blank" rel="noopener">▶ ${esc(set.v)} 실제 예문</a></div>` : ""}
      ${(() => { const xs = GRAM_LIST.filter((x) => x.gkey === key); if (!xs.length) return ""; const sn = xs.filter((x) => curSt(x.id)).length, tr = xs.filter((x) => (curSt(x.id) || {}).st === "train").length, g = xs[0].gs, cu = (window.CURRICULUM || [])[g.ui];
        return `<p class="small muted" style="margin:6px 0 0">📘 오늘의 커리큘럼 연동 · ${cu && UNIT_GRAM[cu.id] && UNIT_GRAM[cu.id].includes(key) ? `단원 ${g.ui + 1}(${esc(cu.t)}) 주제와 함께 · ` : ""}${sn}/${xs.length}문장 훈련${tr ? ` · 복습 중 ${tr}` : ""}${gramToday() && gramToday().key === key ? ' · <b>오늘 커리큘럼 문법</b>' : ""}</p>`; })()}
      <div class="visual">${visual}</div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="trQuiz" style="flex:1">✍️ 영작 퀴즈 ${items.length}문장</button><button class="btn" id="trMore">＋ AI 새 문장</button></div>
      <div id="trQ"></div>
    </div>
    <div class="card" id="trList">${items.map((it, i) => `<div class="item" id="ex-${i}"><div class="en">${tappable(it.en, isTense ? it.hl : "")}</div><div class="ko">${esc(it.ko)}</div>
      ${isVerb ? `<div class="small muted" style="margin-top:4px">${esc(it.note || "")}</div>` : isTense ? "" : partsHtml(it.parts)}
      <div class="acts">${sayBtns(it.en)}${ygBtn(ygPhraseOf(it))}${starBtn({ en: it.en, ko: it.ko, key: isVerb ? set.v : isTense ? it.hl || "" : "", keyKo: isTense ? set.ko : it.note || "", src: isVerb ? "동사 " + set.v : set.name })}</div></div>`).join("")}</div>`;
  [...$("#trSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.m === trainMode));
  $("#trSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { trainMode = b.dataset.m; renderTrain(v); } };
  $("#trChips").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; if (isVerb) verbPick = b.dataset.k; else if (isTense) tensePick = b.dataset.k; else formPick = +b.dataset.k; renderTrain(v); };
  v.querySelectorAll("[data-ex]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); const el = $("#ex-" + a.dataset.ex); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200); } }));
  const hint = isVerb ? set.v + " 사용" : isTense ? `${set.name} (${set.form})` : set.name;
  $("#trQuiz").onclick = () => {
    $("#trList").hidden = true;
    quiz($("#trQ"), items.map((it) => ({ ko: it.ko, en: it.en, hint })), {
      kind: "drill", src: isVerb ? "동사 " + set.v : set.name, target: isVerb ? `the basic verb "${set.v}"` : isTense ? `${set.name} (${set.form})` : `English sentence pattern ${set.name}`,
      onEach: (_, ok) => { const t = { ...trainStat(key) }; t.n++; if (ok) t.ok++; t.at = today(); S.train[key] = t; save(); },
      onDone: () => renderTrain(v),
    });
  };
  $("#trMore").onclick = async () => {
    const b = $("#trMore"); b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
    try {
      const x = await ai("drill", { kind: mode, item: isVerb ? set.v : isTense ? `${set.ko} — ${set.form}` : `${set.n}형식` });
      const add = (x.items || []).filter((i) => i.en && i.ko).map((i) => ({ en: i.en, ko: i.ko, note: i.note || "", parts: i.parts || "", hl: i.hl || "" }));
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
    <div class="seg scroll" id="vSeg"><button data-m="due">복습 ${due.length ? `(${due.length})` : ""}</button><button data-m="saved">저장 문장</button><button data-m="expr">표현</button><button data-m="speakrec">발음</button><button data-m="scn">시나리오</button><button data-m="mono">독백</button><button data-m="words">단어</button></div>
    ${vaultMode !== "due" && vaultMode !== "speakrec" ? `<input class="text" id="vSearch" placeholder="검색" value="${esc(vaultQ)}" style="margin:4px 0 8px">` : ""}
    <div id="vBody"></div>`;
  [...$("#vSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.m === vaultMode));
  $("#vSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) { vaultMode = b.dataset.m; renderVault(v); } };
  if ($("#vSearch")) $("#vSearch").oninput = (e) => { vaultQ = e.target.value; clearTimeout(renderVault._t); renderVault._t = setTimeout(() => { renderVault(v); const s = $("#vSearch"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250); };
  const body = $("#vBody");
  if (vaultMode === "due") {
    const waiting = S.wrong.filter((w) => !w.del && !w.mastered && w.due > today()).sort((a, b) => a.due.localeCompare(b.due));
    const mastered = S.wrong.filter((w) => w.mastered).length, total = allDue().length, doneToday = todayH().review || 0;
    const pushed = Math.max(0, total - due.length);
    const tag = (w) => { const st = rvStats(w); return st.reps === 0 ? `<span class="rvtag new">처음</span>` : st.miss >= 2 && st.miss > st.okc ? `<span class="rvtag bad">자주 틀림</span>` : st.streak >= 3 ? `<span class="rvtag good">연속 ${st.streak}번 정답</span>` : ""; };
    const accTxt = (w) => { const st = rvStats(w); return st.acc == null ? "아직 복습 전" : `정답률 ${st.acc}% (${st.okc}/${st.reps})`; };
    body.innerHTML = `<div class="card">${due.length ? `<div class="row spread"><h3>오늘 복습 ${due.length}문장</h3><span class="small muted">하루 최대 ${REVIEW_DAILY_CAP}문장</span></div>
        <p class="small muted" style="margin:4px 0 0">자주 틀린 문장 → 처음 보는 문장 → 오래 안 본 문장 순서로 나와요.${pushed ? ` 나머지 <b>${pushed}</b>문장은 내일 이후로 밀려요.` : ""}</p>
        <div class="rvlist">${due.slice(0, 5).map((w) => `<div class="small">${tag(w)} ${esc(w.ko)}</div>`).join("")}${due.length > 5 ? `<div class="small muted">… 외 ${due.length - 5}문장</div>` : ""}</div>
        <div id="rvQ" style="margin-top:10px"><button class="btn primary big" id="rvGo">복습 시작</button></div>`
      : total ? `<div class="empty">✅ 오늘 복습 ${doneToday}문장 완료! (하루 최대 ${REVIEW_DAILY_CAP})<br><span class="small">남은 ${total}문장은 내일 이어서 나와요.</span></div>`
      : `<div class="empty">🎉 오늘 복습할 문장이 없어요.<br><span class="small">영작·퀴즈에서 틀린 문장이나 아래에서 직접 넣은 문장이 여기로 들어와요.</span></div>`}</div>
      <div class="card"><details id="rvAddBox"${S.wrong.length ? "" : " open"}><summary><b>＋ 복습 문장 직접 추가</b> <span class="small muted">따로 훈련하고 싶은 영어 문장</span></summary>
        <p class="small muted" style="margin:8px 0 6px">한 줄에 한 문장씩, 최대 10문장. AI가 뜻·문법·원어민 자연스러움을 검토한 뒤 고를 수 있게 보여 드려요.</p>
        <textarea class="text" id="rvAddIn" rows="4" placeholder="e.g. I'm keen to catch up sometime next week.&#10;Could you give me a hand with this?"></textarea>
        <div class="row" style="gap:6px;margin-top:6px"><button class="btn primary" id="rvAddGo">검토하기</button><span class="small muted" id="rvAddMsg"></span></div>
        <div id="rvAddOut"></div></details></div>
      ${waiting.length ? `<div class="card"><div class="row spread"><h3>대기 중 ${waiting.length}</h3><span class="small muted">완전히 익힘 ${mastered}</span></div>${waiting.slice(0, 40).map((w) => `<div class="item"><div class="row spread"><span class="small muted">${esc(w.due)} 복습 · ${accTxt(w)} ${tag(w)}</span><button class="act" data-delw="${w.id}">삭제</button></div><div class="ko" style="color:var(--text)">${esc(w.ko)}</div><div class="en">${esc(w.en)}</div>${w.mine ? `<div class="small muted">${w.manual ? "처음 쓴 문장" : "내 답"}: ${esc(w.mine)}</div>` : ""}</div>`).join("")}</div>` : ""}`;
    if ($("#rvGo")) $("#rvGo").onclick = () => quiz($("#rvQ"), due.map((w) => ({ ko: w.ko, en: w.en, _ref: w })), { kind: "review", onDone: () => render() });
    body.querySelectorAll("[data-delw]").forEach((b) => (b.onclick = () => { S.wrong = S.wrong.filter((w) => w.id !== b.dataset.delw); save(); renderVault(v); }));
    $("#rvAddGo").onclick = () => reviewAddCheck(v);
    $("#rvAddIn").oninput = (e) => { if (!e.target.value.trim()) rvAddCtx = null; };   // 다 지우고 새로 쓰면 일반 문장으로 검토
  } else if (vaultMode === "saved") {
    const list = f(S.saved, ["en", "ko", "src"]);
    body.innerHTML = list.length ? `<div class="row spread small muted" style="margin:0 2px"><span>${list.length}문장</span><span class="row" style="gap:6px"><button class="btn sm" id="svDict">🎧 받아쓰기</button><button class="btn sm" id="svQuiz">퀴즈</button></span></div><div id="svQ"></div><div class="card">${list.map((s) => `<div class="item"><div class="en">${tappable(s.en, s.key)}</div><div class="ko">${esc(s.ko)}</div>${s.keyKo ? `<div class="keybox"><b>${esc(s.key)}</b> — ${esc(s.keyKo)} ${ygBtn(s.key)}</div>` : ""}<div class="acts">${sayBtns(s.en)}<span class="small muted" style="margin-left:auto">${esc(s.src || "")}</span><button class="act" data-dels="${s.id}">삭제</button></div></div>`).join("")}</div>`
      : `<div class="card empty">☆ 저장 버튼을 누른 문장이 여기에 모여요.</div>`;
    body.querySelectorAll("[data-dels]").forEach((b) => (b.onclick = () => { S.saved = S.saved.filter((s) => s.id !== b.dataset.dels); save(); renderVault(v); }));
    if ($("#svDict")) $("#svDict").onclick = () => {
      const pick = list.sort(() => Math.random() - 0.5).slice(0, 5);
      if (!pick.length) return toast("저장한 문장이 없어요");
      openSheet(`<h2>저장 문장 받아쓰기</h2><div id="svDQ"></div>`);
      runRoutine($("#svDQ"), pick.map((x) => ({ en: x.en, ko: x.ko, key: x.key, keyKo: x.keyKo, src: "받아쓰기 저장 문장" })), { mode: "dict", doneLabel: "닫기", onFinish: () => { closeSheet(); renderVault(v); } });
    };
    if ($("#svQuiz")) $("#svQuiz").onclick = () => { const pick = list.filter((s) => s.ko).sort(() => Math.random() - 0.5).slice(0, 10); if (!pick.length) return toast("한국어 해석이 있는 문장이 없어요"); $("#svQuiz").remove(); quiz($("#svQ"), pick.map((s) => ({ ko: s.ko, en: s.en })), { kind: "review_saved", src: "저장 문장" }); };
  } else if (vaultMode === "expr") {
    const list = f(Object.values(S.expr).map((e) => ({ ...e })), ["k", "ko"]).sort((a, b) => exprDone(a) - exprDone(b) || (b.seen || "").localeCompare(a.seen || ""));
    const done = list.filter((e) => exprDone(e) === STAGES.length).length;
    body.innerHTML = list.length ? `<div class="small muted" style="margin:0 2px 6px">저장한 핵심 표현 ${list.length}개 · 완전히 익힘 ${done}개 · 덜 익힌 표현이 위에 있어요. 듣고 받아쓰고, 따라 말하고, 영작에서 직접 쓰고, 복습을 통과하면 단계가 올라가요.</div><div class="card">${list.map((e) => `<div class="item"><div class="row spread"><b>${esc(e.k)}</b>${ygBtn(e.k)}</div><div class="ko">${esc(e.ko || "")}</div><div class="steps">${STAGES.map(([k, l]) => `<span class="step ${e[k] ? "on" : ""}">${l}</span>`).join("")}</div><div class="acts">${sayBtns(e.k)}</div></div>`).join("")}</div>`
      : `<div class="card empty">☆ 저장한 문장의 핵심 표현이 여기에 모여요.<br><span class="small">단계가 올라가는 걸 확인하며 '쓸 수 있는 표현'으로 만들어 보세요.</span></div>`;
  } else if (vaultMode === "speakrec") {
    const recs = Object.entries(S.speak).map(([k, r]) => ({ k, ...r }));
    if (!recs.length) { body.innerHTML = `<div class="card empty">스피킹에서 🎙 따라 말하기를 하면 문장별 일치율이 여기에 기록돼요.</div>`; }
    else {
      const bySc = {}; for (const r of recs) (bySc[r.sc] = bySc[r.sc] || { t: r.t, a: [] }).a.push(r);
      const low = recs.filter((r) => r.last < 70).sort((a, b) => a.last - b.last);
      body.innerHTML = `<div class="card"><h3>시나리오별 평균</h3>${Object.values(bySc).map((g) => { const avg = Math.round(g.a.reduce((x, r) => x + r.last, 0) / g.a.length), gain = Math.round(g.a.reduce((x, r) => x + r.last - r.first, 0) / g.a.length); return `<div class="wk" style="margin-top:8px"><div style="flex:1"><div class="row spread"><b class="small">${esc(g.t)}</b><span class="small muted">${avg}% · 첫 시도 대비 ${gain >= 0 ? "+" : ""}${gain}p · ${g.a.length}문장</span></div><div class="wk-bar"><i style="width:${avg}%"></i></div></div></div>`; }).join("")}</div>
        <div class="card"><h3>발음 다시 연습 <small class="muted">70% 미만 ${low.length}문장</small></h3>${low.length ? low.map((r) => `<div class="item"><div class="en">${tappable(r.en)}</div><div class="small muted" id="pr-${esc(r.k)}">최근 ${r.last}% · 최고 ${r.best}% · ${r.n}회</div><div class="acts">${sayBtns(r.en)}<button class="act" data-pr="${esc(r.k)}">🎙 다시 말하기</button></div></div>`).join("") : `<div class="empty">🎉 70% 미만인 문장이 없어요.</div>`}</div>`;
      body.onclick = async (e) => {
        const b = e.target.closest("[data-pr]"); if (!b) return;
        const r = S.speak[b.dataset.pr], out = document.getElementById("pr-" + b.dataset.pr); if (!r) return;
        out.innerHTML = '<span class="spinner"></span> 말해 보세요…';
        try {
          const h = await hearSentence(r.en, out); if (!h) return;
          const sc = allScenarios().find((x) => x.id === r.sc), i = r.i, best = h.score;
          shadowResult({ en: r.en, ko: sc && sc.lines[i] ? sc.lines[i].ko : "" }, h, "발음 연습 · " + (r.t || "").split(" — ")[0]);
          if (sc && sc.lines[i]) { const rec = recordSpeak(sc, i, best); out.innerHTML = `<span class="tag ${best >= 80 ? "good" : "bad"}">${best}%</span> 최고 ${rec.best}% · ${rec.n}회${hearHtml(h)}`; if (best >= 80) log("shadow"); }
          else out.innerHTML = `<span class="tag">${best}%</span>${hearHtml(h)}`;
        } catch (err) { out.textContent = err.message; }
      };
    }
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
  } else if (vaultMode === "mono") {
    const monos = savedMonos(), list = f(monos, ["title", "cue", "topic"]);
    const recs = (id) => S.monoLog.filter((x) => x.m === id), best = (id) => Math.max(0, ...recs(id).map((x) => x.acc || 0));
    body.innerHTML = list.length ? `<div class="card">${list.map((m) => `<div class="item"><div class="row spread"><b>${esc(m.title)}</b><span class="tag">${m.custom ? "내 이야기" : esc(m.topic || "필수")}</span></div>
        <div class="small muted">${esc(m.cue || "")}</div>
        <div class="small muted">${m.lines.length}문장${m.at ? " · " + esc(m.at.slice(0, 10)) : ""}${recs(m.id).length ? ` · 낭독 ${recs(m.id).length}회${best(m.id) ? ` · 최고 완독 ${best(m.id)}%` : ""}` : ""}</div>
        <div class="acts"><button class="act" data-mopen="${esc(m.id)}">열기</button><button class="act" data-msay="${esc(m.id)}">🔊 듣기</button><button class="act" data-mcopy="${esc(m.id)}">전체 문장 복사</button>${m.custom ? `<button class="act" data-mdel="${esc(m.id)}">삭제</button>` : `<button class="act" data-munfav="${esc(m.id)}">보관 해제</button>`}</div></div>`).join("")}</div>`
      : `<div class="card empty">독백 화면에서 '☆ 독백 보관'을 누르거나 '＋ 내 이야기로'로 만든 독백이 여기에 보관돼요.</div>`;
    let playingM = false;
    body.onclick = async (e) => {
      const o = e.target.closest("[data-mopen]"), c = e.target.closest("[data-mcopy]"), d = e.target.closest("[data-mdel]"), u = e.target.closest("[data-munfav]"), sy = e.target.closest("[data-msay]");
      if (o) { S.done["mpick:" + today()] = o.dataset.mopen; monoLast = null; save(); go("mono"); }
      if (c) { const m = monos.find((x) => x.id === c.dataset.mcopy); const txt = m.title + "\n\n" + m.lines.map((l) => `${monoText(l.en)}\n   ${l.ko}`).join("\n"); navigator.clipboard?.writeText(txt).then(() => toast("복사했어요"), () => toast("복사 실패")); }
      if (d && confirm("이 독백을 삭제할까요? (녹음은 기기에 남아요)")) { S.monos = S.monos.filter((x) => x.id !== d.dataset.mdel); save(); renderVault(v); }
      if (u) { S.done["mfav:" + u.dataset.munfav] = false; save(); renderVault(v); }
      if (sy) {
        if (playingM) { playingM = false; window.speechSynthesis?.cancel(); sy.textContent = "🔊 듣기"; return; }
        const m = monos.find((x) => x.id === sy.dataset.msay); playingM = true; sy.textContent = "■ 멈춤";
        for (const l of m.lines) { if (!playingM) break; await speak(monoText(l.en)); await sleep(250); }
        playingM = false; sy.textContent = "🔊 듣기";
      }
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
// 데일리 브리프 '영어로 익히기'에서 보낸 문장(?add=…&from=news&ko=…): 로그인 뒤 복습 '직접 추가'에 채워 바로 검토
(() => {
  const q = new URLSearchParams(location.search), add = (q.get("add") || "").trim();
  if (!add) return;
  try { sessionStorage.setItem("et:pendingAdd", JSON.stringify({ text: add.slice(0, 600), from: (q.get("from") || "").slice(0, 20), ko: (q.get("ko") || "").slice(0, 200) })); } catch {}
  history.replaceState(null, "", location.pathname + "#vault");
})();
const remembered = lsGet("et:code");
if (remembered) login(remembered); else { $("#login").hidden = false; $("#codeInput").focus(); }
})();
