/* 雅思词汇独立站 · 前端逻辑（直接连 Supabase PostgREST，anon 角色） */
"use strict";
const BOX_DAYS = [1, 3, 7, 14, 30]; // box 0..4 对应复习间隔（天）；答错回 box 0、次日复习
const AUDIO_BASE = window.SUPABASE_URL + "/storage/v1/object/public/audio/";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString(); };
const fmtDate = s => s ? new Date(s).toLocaleString("zh-CN", { timeZone: "America/Toronto" }) : "—";
const isDue = iso => !iso || new Date(iso) <= new Date();

let S = { student: null, words: [], examples: [], sets: [], lwordsBySet: {}, wprog: {}, lprog: {},
  tier: 1, cardList: [], cardIdx: 0, cardFlipped: false,
  quiz: null, listen: null };

/* ---- Supabase REST ---- */
async function sb(path, method = "GET", body = null, prefer = null) {
  const headers = {
    "apikey": window.SUPABASE_ANON_KEY,
    "Authorization": "Bearer " + window.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  };
  if (prefer) headers["Prefer"] = prefer;
  const res = await fetch(window.SUPABASE_URL + "/rest/v1/" + path, { method, headers, body: body ? JSON.stringify(body) : null });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) throw new Error("请求失败 " + res.status + ": " + (data && data.message ? data.message : text));
  return data;
}
async function upsertProgress(table, row) {
  const key = table === "word_progress" ? "student_id,word_id" : "student_id,word_id";
  return sb(table + "?on_conflict=" + key, "POST", row, "resolution=merge-duplicates,return=representation");
}
function srsNext(correct, box) {
  if (!correct) return { box: 0, next: addDays(1), state: "unknown" };
  const nb = Math.min((box || 0) + 1, 4);
  return { box: nb, next: addDays(BOX_DAYS[nb]), state: "known" };
}

/* ---- 登录 ---- */
async function doLogin() {
  const code = $("login-code").value.trim();
  const err = $("login-error"); err.classList.add("hidden");
  if (!code) { err.textContent = "请先输入学习码。"; err.classList.remove("hidden"); return; }
  $("btn-login").disabled = true;
  try {
    const rows = await sb("students?code=eq." + encodeURIComponent(code) + "&select=*");
    if (!rows || !rows.length) { err.textContent = "没有找到这个学习码，请检查后重新输入，或联系 Jessica 老师。"; err.classList.remove("hidden"); return; }
    const st = rows[0];
    if (st.disabled) { err.textContent = "这个学习码已被停用，请联系 Jessica 老师。"; err.classList.remove("hidden"); return; }
    await sb("students?id=eq." + st.id, "PATCH", { login_count: (st.login_count || 0) + 1, last_login_at: new Date().toISOString() });
    st.login_count = (st.login_count || 0) + 1;
    try { await sb("login_history", "POST", { student_id: st.id }); } catch (e) { /* 登录记录失败不影响登录 */ }
    S.student = st;
    await enterApp();
  } catch (e) {
    err.textContent = "登录时出了点问题，请稍后再试（" + esc(e.message) + "）。";
    err.classList.remove("hidden");
  } finally { $("btn-login").disabled = false; }
}
function doLogout() {
  S.student = null;
  $("view-app").classList.add("hidden");
  $("view-login").classList.remove("hidden");
  $("login-code").value = "";
  try { sessionStorage.removeItem("ielts_code"); } catch (e) {}
}
async function enterApp() {
  $("view-login").classList.add("hidden");
  $("view-app").classList.remove("hidden");
  $("hello-name").textContent = "你好，" + S.student.name + " 👋";
  $("hello-sub").textContent = S.student.is_teacher ? "（老师）· 这是你第 " + S.student.login_count + " 次登录" : " · 这是你第 " + S.student.login_count + " 次登录";
  if (S.student.is_teacher) $("nav-teacher").classList.remove("hidden");
  else $("nav-teacher").classList.add("hidden");
  try { sessionStorage.setItem("ielts_code", S.student.code); } catch (e) {}
  await loadAllData();
  renderCards(); renderMastery(); renderReview(); buildListenSets();
  if (S.student.is_teacher) renderTeacher();
}
async function loadAllData() {
  const [words, examples, sets, wprog, lprog] = await Promise.all([
    sb("words?select=*&order=num&limit=1000"),
    sb("examples?select=*&order=id&limit=100"),
    sb("listening_sets?select=*&order=id"),
    sb("word_progress?student_id=eq." + S.student.id + "&select=*&limit=2000"),
    sb("listening_progress?student_id=eq." + S.student.id + "&select=*&limit=5000")
  ]);
  S.words = words || []; S.examples = examples || []; S.sets = sets || [];
  S.wprog = {}; (wprog || []).forEach(p => S.wprog[p.word_id] = p);
  S.lprog = {}; (lprog || []).forEach(p => S.lprog[p.word_id] = p);
}
async function loadListenWords(setId) {
  if (S.lwordsBySet[setId]) return S.lwordsBySet[setId];
  const rows = await sb("listening_words?set_id=eq." + encodeURIComponent(setId) + "&select=*&order=num&limit=2000");
  S.lwordsBySet[setId] = rows || [];
  return S.lwordsBySet[setId];
}

/* ---- 导航 ---- */
document.querySelectorAll("#nav-tabs button").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll("#nav-tabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    ["reading", "quiz", "listening", "review", "wordlist", "teacher"].forEach(t => $("tab-" + t).classList.add("hidden"));
    $("tab-" + b.dataset.tab).classList.remove("hidden");
    if (b.dataset.tab === "review") renderReview();
    if (b.dataset.tab === "teacher") renderTeacher();
    if (b.dataset.tab === "reading") renderMastery();
    if (b.dataset.tab === "wordlist") buildWordList();
  });
});
$("btn-login").addEventListener("click", doLogin);
$("login-code").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
$("btn-logout").addEventListener("click", doLogout);

/* ---- 阅读闪卡 ---- */
function tierWords(t) { return S.words.filter(w => w.tier === t); }
function renderCards() {
  S.tier = parseInt($("tier-select").value, 10);
  S.cardList = tierWords(S.tier);
  S.cardIdx = 0; S.cardFlipped = false;
  showCard();
}
function showCard() {
  const area = $("card-area");
  if (!S.cardList.length) {
    area.innerHTML = '<p class="muted center">这个词类还没有词（词库正在准备中）。</p>';
    $("card-count").textContent = ""; $("card-progress").style.width = "0%"; return;
  }
  const w = S.cardList[S.cardIdx];
  const p = S.wprog[w.id];
  const status = p ? (p.state === "known" ? "已认识 · 下次复习 " + fmtDate(p.next_review_at) : "待复习") : "还没练过";
  area.innerHTML =
    '<div class="card flash" id="flash-card" style="box-shadow:none;border:1.5px solid var(--line)">' +
    '<div class="tag">第 ' + w.tier + ' 类 · #' + w.num + ' · ' + esc(status) + (w.needs_review ? ' · 待校对' : '') + '</div>' +
    '<div class="big-word">' + esc(w.word) + '</div>' +
    (w.pos ? '<div class="muted">' + esc(w.pos) + '</div>' : '') +
    (S.cardFlipped
      ? '<div class="meaning">' + esc(w.meaning_zh) + '</div>' +
        (w.synonyms && w.synonyms.length ? '<div class="syn">同义词：' + esc(w.synonyms.join("、")) + '</div>' : '') +
        '<div class="hint">再点一次收起</div>'
      : '<div class="meaning" style="color:var(--muted)">？</div><div class="hint">点卡片看中文意思</div>') +
    '</div>';
  $("flash-card").addEventListener("click", () => { S.cardFlipped = !S.cardFlipped; showCard(); });
  $("card-progress").style.width = ((S.cardIdx + 1) / S.cardList.length * 100) + "%";
  $("card-count").textContent = "第 " + (S.cardIdx + 1) + " / " + S.cardList.length + " 个";
}
async function markCard(known) {
  const w = S.cardList[S.cardIdx]; if (!w) return;
  const cur = S.wprog[w.id];
  const r = srsNext(known, cur ? cur.box : 0);
  const row = { student_id: S.student.id, word_id: w.id, state: r.state, box: r.box, next_review_at: r.next, updated_at: new Date().toISOString() };
  try { const saved = await upsertProgress("word_progress", row); if (saved && saved[0]) S.wprog[w.id] = saved[0]; else S.wprog[w.id] = row; } catch (e) { /* 离线也继续翻卡 */ }
  S.cardFlipped = false;
  S.cardIdx = Math.min(S.cardIdx + 1, S.cardList.length - 1);
  showCard(); renderMastery();
}
$("tier-select").addEventListener("change", renderCards);
$("btn-shuffle-cards").addEventListener("click", () => { S.cardList = shuffle(S.cardList); S.cardIdx = 0; S.cardFlipped = false; showCard(); });
$("btn-prev-card").addEventListener("click", () => { S.cardIdx = Math.max(0, S.cardIdx - 1); S.cardFlipped = false; showCard(); });
$("btn-next-card").addEventListener("click", () => { S.cardIdx = Math.min(S.cardList.length - 1, S.cardIdx + 1); S.cardFlipped = false; showCard(); });
$("btn-known").addEventListener("click", () => markCard(true));
$("btn-unknown").addEventListener("click", () => markCard(false));

function renderMastery() {
  const el = $("mastery-stats");
  el.innerHTML = [1, 2, 3].map(t => {
    const list = tierWords(t);
    const known = list.filter(w => S.wprog[w.id] && S.wprog[w.id].state === "known").length;
    const studied = list.filter(w => S.wprog[w.id]).length;
    return '<div class="stat"><b>' + known + ' / ' + list.length + '</b><span>第 ' + t + ' 类已认识</span><br><span>练过 ' + studied + ' 个</span></div>';
  }).join("");
}

/* ---- 阅读测验 ---- */
function pickDistractors(pool, correct, n) {
  const out = [];
  shuffle(pool).forEach(v => { if (out.length < n && v && v !== correct && !out.includes(v)) out.push(v); });
  return out;
}
function buildQuizQuestions(mode, tier, size) {
  const pool = tier ? S.words.filter(w => w.tier === tier) : S.words.slice();
  if (!size || size <= 0) size = pool.length; // 0 = 全部
  const qs = [];
  if (mode === "gloss") {
    shuffle(pool).slice(0, size).forEach(w => {
      const opts = shuffle([w.meaning_zh].concat(pickDistractors(S.words.map(x => x.meaning_zh), w.meaning_zh, 3)));
      qs.push({ kind: "gloss", word: w, word_id: w.id, stem: "「" + w.word + "」的中文意思是？", options: opts, answer: w.meaning_zh, tag: null });
    });
  } else if (mode === "synonym") {
    const withSyn = pool.filter(w => w.synonyms && w.synonyms.length);
    const allSyn = S.words.flatMap(w => w.synonyms || []);
    shuffle(withSyn).slice(0, size).forEach(w => {
      const correct = w.synonyms[0];
      const opts = shuffle([correct].concat(pickDistractors(allSyn, correct, 3)));
      qs.push({ kind: "synonym", word: w, word_id: w.id, stem: "哪个词可以替换「" + w.word + "」（" + w.meaning_zh + "）？", options: opts, answer: correct, tag: null });
    });
  } else if (mode === "sentence") {
    const exs = shuffle(S.examples.slice());
    exs.slice(0, size).forEach(ex => {
      const optsRaw = Array.isArray(ex.options) ? ex.options : [];
      const opts = optsRaw.length ? shuffle(optsRaw.slice()) : null;
      qs.push({ kind: "sentence", word: null, example_id: ex.id, word_id: null,
        stem: (ex.passage ? "原文：" + ex.passage + "\n" : "") + (ex.stem || "") + (ex.question ? "\n" + ex.question : ""),
        options: opts, answer: ex.answer, tag: "真题例句", source: ex.source });
    });
    // 真题例句不足时，用练习句补足（明确标注）
    if (qs.length < size) {
      const rest = shuffle(pool).slice(0, size - qs.length);
      rest.forEach(w => {
        const opts = shuffle([w.meaning_zh].concat(pickDistractors(S.words.map(x => x.meaning_zh), w.meaning_zh, 3)));
        qs.push({ kind: "gloss", word: w, word_id: w.id, stem: "在练习句中，「" + w.word + "」最可能的意思是？", options: opts, answer: w.meaning_zh, tag: "练习句" });
      });
    }
  } else if (mode === "review") {
    const wrong = pool.filter(w => { const p = S.wprog[w.id]; return p && (p.state === "unknown" || isDue(p.next_review_at)); });
    const base = wrong.length ? wrong : shuffle(pool);
    shuffle(base).slice(0, size).forEach(w => {
      const opts = shuffle([w.meaning_zh].concat(pickDistractors(S.words.map(x => x.meaning_zh), w.meaning_zh, 3)));
      qs.push({ kind: "gloss", word: w, word_id: w.id, stem: "「" + w.word + "」的中文意思是？", options: opts, answer: w.meaning_zh, tag: null });
    });
  }
  return qs.slice(0, size);
}
$("btn-start-quiz").addEventListener("click", () => {
  const mode = $("quiz-mode").value;
  const tier = parseInt($("quiz-tier").value, 10);
  const size = parseInt($("quiz-size").value, 10);
  const qs = buildQuizQuestions(mode, tier, size);
  if (!qs.length) { alert("题库还没有内容（词库正在准备中），请稍后再试。"); return; }
  S.quiz = { mode, qs, idx: 0, correct: 0, answers: [] };
  $("quiz-setup").classList.add("hidden");
  $("quiz-result").classList.add("hidden");
  $("quiz-run").classList.remove("hidden");
  $("quiz-title").textContent = { gloss: "中文意思", synonym: "同义替换", sentence: "真题例句", review: "错词重练" }[mode] + " · " + qs.length + " 题";
  showQuizQ();
});
function showQuizQ() {
  const q = S.quiz.qs[S.quiz.idx];
  $("quiz-progress").textContent = "第 " + (S.quiz.idx + 1) + " / " + S.quiz.qs.length + " 题";
  $("quiz-bar").style.width = ((S.quiz.idx) / S.quiz.qs.length * 100) + "%";
  $("quiz-feedback").innerHTML = "";
  $("btn-next-q").classList.add("hidden");
  let stemHtml = "<div style='white-space:pre-wrap;font-size:17px'>" + esc(q.stem) + "</div>";
  if (q.tag) stemHtml += '<p><span class="pill ' + (q.tag === "练习句" ? "badge-practice" : "badge-true") + '">' + q.tag + "</span></p>";
  if (q.kind === "sentence" && q.source) stemHtml += '<p class="tag">来源：' + esc(q.source) + "</p>";
  $("quiz-q").innerHTML = stemHtml;
  const box = $("quiz-opts"); box.innerHTML = "";
  if (!q.options || !q.options.length) {
    box.innerHTML = '<p class="muted">这道题是填空题，请直接看答案：<b>' + esc(q.answer) + "</b></p>";
    const b = document.createElement("button"); b.textContent = "我答对了"; b.className = "secondary";
    const b2 = document.createElement("button"); b2.textContent = "我答错了"; b2.className = "ghost";
    b.onclick = () => gradeQuiz(true, q, "(自评)"); b2.onclick = () => gradeQuiz(false, q, "(自评)");
    box.appendChild(b); box.appendChild(b2); return;
  }
  q.options.forEach(opt => {
    const b = document.createElement("button");
    b.className = "opt"; b.textContent = opt;
    b.onclick = () => gradeQuiz(opt === q.answer, q, opt);
    box.appendChild(b);
  });
}
async function gradeQuiz(ok, q, given) {
  document.querySelectorAll("#quiz-opts .opt").forEach(b => {
    b.disabled = true;
    if (b.textContent === q.answer) b.classList.add("correct");
    else if (b.textContent === given && !ok) b.classList.add("wrong");
  });
  S.quiz.answers.push({ word_id: q.word_id, example_id: q.example_id || null, given: String(given), correct: ok });
  if (ok) S.quiz.correct++;
  $("quiz-feedback").innerHTML = ok
    ? '<div class="feedback ok">✓ 答对了' + (q.word ? " —— " + esc(q.word.word) + "：" + esc(q.word.meaning_zh) : "") + "</div>"
    : '<div class="feedback no">✗ 答错了，正确答案是：' + esc(q.answer) + (q.word ? "（" + esc(q.word.word) + "：" + esc(q.word.meaning_zh) + "）" : "") + "</div>";
  $("btn-next-q").classList.remove("hidden");
  // 同步更新 SRS 进度
  if (q.word_id) {
    const cur = S.wprog[q.word_id];
    const r = srsNext(ok, cur ? cur.box : 0);
    const row = { student_id: S.student.id, word_id: q.word_id, state: r.state, box: r.box, next_review_at: r.next, updated_at: new Date().toISOString() };
    try { const saved = await upsertProgress("word_progress", row); S.wprog[q.word_id] = (saved && saved[0]) || row; } catch (e) {}
  }
}
$("btn-next-q").addEventListener("click", async () => {
  S.quiz.idx++;
  if (S.quiz.idx >= S.quiz.qs.length) { await finishQuiz(); return; }
  showQuizQ();
});
async function finishQuiz() {
  const total = S.quiz.qs.length, correct = S.quiz.correct;
  $("quiz-run").classList.add("hidden");
  const res = $("quiz-result");
  res.classList.remove("hidden");
  res.innerHTML = "<h2>测验完成 🎉</h2><p style='font-size:22px'>得分：<b>" + correct + " / " + total + "</b>（" + Math.round(correct / total * 100) + "%）</p>" +
    "<p class='muted'>答错的词已安排明天复习，答对的词按 1 / 3 / 7 / 14 / 30 天的间隔回来。</p>" +
    "<button id='btn-quiz-again'>再测一次</button>";
  $("btn-quiz-again").onclick = () => { $("quiz-result").classList.add("hidden"); $("quiz-setup").classList.remove("hidden"); };
  try {
    const att = await sb("quiz_attempts", "POST", { student_id: S.student.id, mode: S.quiz.mode, total, correct }, "return=representation");
    const attemptId = att && att[0] && att[0].id;
    if (attemptId && S.quiz.answers.length) {
      await sb("quiz_answers", "POST", S.quiz.answers.map(a => ({ attempt_id: attemptId, word_id: a.word_id, example_id: a.example_id, given: a.given, correct: a.correct })));
    }
  } catch (e) { /* 成绩保存失败不影响显示 */ }
  renderMastery(); renderReview();
}

/* ---- 单词表（查词） ---- */
let wordlistLoaded = false;
async function buildWordList() {
  if (!wordlistLoaded) {
    try { await Promise.all(S.sets.map(s => loadListenWords(s.id))); } catch (e) {}
    wordlistLoaded = true;
  }
  renderWordList();
}
function renderWordList() {
  const q = ($("wordlist-search").value || "").trim().toLowerCase();
  const res = $("wordlist-results");
  if (!q) { res.innerHTML = '<p class="muted">阅读 376 词 + 听力 1449 词都在这里，输入上面搜索单词或中文意思。</p>'; return; }
  const hits = [];
  S.words.forEach(w => { if (w.word.toLowerCase().includes(q) || (w.meaning_zh || "").includes(q)) hits.push({ word: w.word, pos: w.pos, meaning: w.meaning_zh, src: "阅读 · 第" + w.tier + "类" }); });
  Object.entries(S.lwordsBySet).forEach(([setId, list]) => {
    const label = (S.sets.find(s => s.id === setId) || {}).label || setId;
    (list || []).forEach(w => { if (w.word.toLowerCase().includes(q) || (w.meaning_zh || "").includes(q)) hits.push({ word: w.word, pos: w.pos, meaning: w.meaning_zh, src: "听力 · " + label }); });
  });
  if (!hits.length) { res.innerHTML = '<p class="err">没有找到“' + esc(q) + '”。</p>'; return; }
  res.innerHTML = "<p class='muted'>找到 " + hits.length + " 条（只显示前 50 条）：</p>" +
    "<table><tr><th>单词</th><th>词性</th><th>中文意思</th><th>来源</th></tr>" +
    hits.slice(0, 50).map(h => "<tr><td><b>" + esc(h.word) + "</b></td><td>" + esc(h.pos || "") + "</td><td>" + esc(h.meaning || "") + "</td><td>" + esc(h.src) + "</td></tr>").join("") + "</table>";
}
$("wordlist-search").addEventListener("input", renderWordList);
$("btn-add-word").addEventListener("click", async () => {
  const word = $("add-word-word").value.trim();
  const pos = $("add-word-pos").value.trim();
  const meaning = $("add-word-meaning").value.trim();
  const tier = parseInt($("add-word-tier").value, 10);
  const msg = $("add-word-msg");
  if (!word || !meaning) { msg.innerHTML = '<p class="err">单词和中文意思都要填。</p>'; return; }
  const btn = $("btn-add-word"); btn.disabled = true;
  try {
    // 是否已在词库里（先查本地，再查服务器，不区分大小写）
    if (S.words.some(w => (w.word || "").toLowerCase() === word.toLowerCase())) { msg.innerHTML = '<p class="ok-msg">“' + esc(word) + '”已经在词库里了，不用重复加。</p>'; return; }
    const existing = await sb("words?word=ilike." + encodeURIComponent(word) + "&select=id,word");
    if (existing && existing.length) { msg.innerHTML = '<p class="ok-msg">“' + esc(existing[0].word) + '”已经在词库里了，不用重复加。</p>'; return; }
    const maxRow = await sb("words?select=num&order=num.desc&limit=1");
    const num = (maxRow && maxRow[0] ? maxRow[0].num : 376) + 1;
    const rows = await sb("words", "POST", { num, word, pos, meaning_zh: meaning, synonyms: [], tier, needs_review: true }, "return=representation");
    if (rows && rows[0]) S.words.push(rows[0]);
    msg.innerHTML = '<p class="ok-msg">已加进词库（编号 ' + num + '），大家现在都能查到。</p>';
    $("add-word-word").value = ""; $("add-word-pos").value = ""; $("add-word-meaning").value = "";
    renderWordList();
  } catch (e) {
    msg.innerHTML = '<p class="err">添加失败，请再试一次（' + esc(e.message) + '）。</p>';
  } finally { btn.disabled = false; }
});

/* ---- 听力听写 ---- */
function buildListenSets() {
  const sel = $("listen-set");
  sel.innerHTML = S.sets.map(s => '<option value="' + esc(s.id) + '">' + esc(s.label) + "（" + esc(s.id) + "）</option>").join("");
  if (!S.sets.length) sel.innerHTML = '<option value="">（词套正在准备中）</option>';
}
$("btn-start-listen").addEventListener("click", async () => {
  const setId = $("listen-set").value;
  const mode = $("listen-mode").value;
  const size = parseInt($("listen-size").value, 10);
  if (!setId) { alert("词套还没有内容（词库正在准备中），请稍后再试。"); return; }
  const all = await loadListenWords(setId);
  let pool = all.slice();
  if (mode === "random") pool = shuffle(pool);
  if (mode === "due") pool = pool.filter(w => { const p = S.lprog[w.id]; return !p || isDue(p.next_review_at); });
  if (!pool.length) { alert(mode === "due" ? "这套词今天没有到期的词，太棒了！" : "这套词还没有内容。"); return; }
  if (size > 0) pool = pool.slice(0, size);
  S.listen = { setId, mode, words: pool, idx: 0, correct: 0, answers: [], graded: false, audio: null };
  $("listen-setup").classList.add("hidden");
  $("listen-result").classList.add("hidden");
  $("listen-run").classList.remove("hidden");
  $("listen-title").textContent = (S.sets.find(s => s.id === setId) || {}).label + " · " + pool.length + " 个词";
  showListenWord();
});
function playCurrentAudio() {
  const w = S.listen.words[S.listen.idx];
  if (!w || !w.audio_path) { $("listen-hint").textContent = "这个词暂无录音，请直接拼写"; return; }
  if (S.listen.audio) { try { S.listen.audio.pause(); } catch (e) {} }
  const a = new Audio(AUDIO_BASE + w.audio_path);
  S.listen.audio = a;
  a.play().catch(() => { $("listen-hint").textContent = "录音播放失败，请点播放再试一次"; });
}
function showListenWord() {
  const w = S.listen.words[S.listen.idx];
  S.listen.graded = false;
  $("listen-progress").textContent = "第 " + (S.listen.idx + 1) + " / " + S.listen.words.length + " 个";
  $("listen-bar").style.width = (S.listen.idx / S.listen.words.length * 100) + "%";
  $("listen-hint").textContent = "听一听，拼出这个单词";
  $("listen-feedback").innerHTML = "";
  const inp = $("listen-input");
  inp.value = ""; inp.readOnly = false;
  playCurrentAudio();
  setTimeout(() => inp.focus(), 50);
}
$("btn-play").addEventListener("click", playCurrentAudio);
$("listen-input").addEventListener("keydown", async e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!S.listen) return;
  if (!S.listen.graded) { await gradeListen(); return; }
  // 已判分：进入下一词
  S.listen.idx++;
  if (S.listen.idx >= S.listen.words.length) { await finishListen(); return; }
  showListenWord();
});
async function gradeListen() {
  const w = S.listen.words[S.listen.idx];
  const inp = $("listen-input");
  const given = inp.value.trim();
  const ok = given.toLowerCase() === (w.word || "").toLowerCase();
  S.listen.graded = true;
  inp.readOnly = true;
  S.listen.answers.push({ word_id: w.id, given, correct: ok });
  if (ok) S.listen.correct++;
  $("listen-feedback").innerHTML = ok
    ? '<div class="feedback ok">✓ 拼对了！' + esc(w.word) + " —— " + esc(w.meaning_zh) + "</div>"
    : '<div class="feedback no">✗ 正确拼写是：<b>' + esc(w.word) + "</b> —— " + esc(w.meaning_zh) + (given ? "（你写的是：" + esc(given) + "）" : "（你没有输入）") + "</div>";
  $("listen-hint").textContent = "再按一次回车，进入下一词";
  const cur = S.lprog[w.id];
  const r = srsNext(ok, cur ? cur.box : 0);
  const row = { student_id: S.student.id, word_id: w.id, state: r.state, box: r.box, next_review_at: r.next, updated_at: new Date().toISOString() };
  try { const saved = await upsertProgress("listening_progress", row); S.lprog[w.id] = (saved && saved[0]) || row; } catch (e) {}
}
async function finishListen() {
  const total = S.listen.words.length, correct = S.listen.correct;
  $("listen-run").classList.add("hidden");
  const res = $("listen-result");
  res.classList.remove("hidden");
  res.innerHTML = "<h2>听写完成 🎧</h2><p style='font-size:22px'>得分：<b>" + correct + " / " + total + "</b>（" + Math.round(correct / total * 100) + "%）</p>" +
    "<p class='muted'>拼错的词已安排明天复习，拼对的词按 1 / 3 / 7 / 14 / 30 天的间隔回来。</p>" +
    "<button id='btn-listen-again'>再练一组</button>";
  $("btn-listen-again").onclick = () => { $("listen-result").classList.add("hidden"); $("listen-setup").classList.remove("hidden"); };
  try {
    const att = await sb("listening_attempts", "POST", { student_id: S.student.id, set_id: S.listen.setId, mode: S.listen.mode, total, correct }, "return=representation");
    const attemptId = att && att[0] && att[0].id;
    if (attemptId && S.listen.answers.length) {
      await sb("listening_answers", "POST", S.listen.answers.map(a => ({ attempt_id: attemptId, word_id: a.word_id, given: a.given, correct: a.correct })));
    }
  } catch (e) {}
  renderReview();
}

/* ---- 我的复习 ---- */
async function renderReview() {
  if (!S.student) return;
  const dueW = S.words.filter(w => { const p = S.wprog[w.id]; return p && isDue(p.next_review_at); });
  const overdueW = S.words.filter(w => { const p = S.wprog[w.id]; return p && p.next_review_at && new Date(p.next_review_at) < new Date(Date.now() - 86400000); });
  let dueL = 0, overdueL = 0;
  Object.values(S.lprog).forEach(p => { if (isDue(p.next_review_at)) { dueL++; if (p.next_review_at && new Date(p.next_review_at) < new Date(Date.now() - 86400000)) overdueL++; } });
  const el = $("review-stats");
  if (el) el.innerHTML =
    '<div class="stat"><b>' + dueW.length + '</b><span>阅读到期词</span></div>' +
    '<div class="stat"><b>' + overdueW.length + '</b><span>阅读过期词</span></div>' +
    '<div class="stat"><b>' + dueL + '</b><span>听力到期词</span></div>' +
    '<div class="stat"><b>' + overdueL + '</b><span>听力过期词</span></div>';
  $("due-words").innerHTML = dueW.length
    ? dueW.slice(0, 30).map(w => '<span class="pill">' + esc(w.word) + "</span>").join("") + (dueW.length > 30 ? '<p class="muted">还有 ' + (dueW.length - 30) + " 个……</p>" : "")
    : '<p class="muted">今天没有到期的阅读词，继续保持！</p>';
  // 听力到期词需要按套查词名；先显示数量，点击可进听写（到期复习模式）
  $("due-listen").innerHTML = dueL
    ? '<p>今天有 <b>' + dueL + '</b> 个听力词到期。请到「听力听写」选「到期复习」模式练习。</p>'
    : '<p class="muted">今天没有到期的听力词，继续保持！</p>';
}
$("btn-review-quiz").addEventListener("click", () => {
  document.querySelector('[data-tab="quiz"]').click();
  $("quiz-mode").value = "review";
  $("btn-start-quiz").click();
});

/* ---- 老师看板 ---- */
let T = { students: [], wprogAll: [], lprogAll: [], quizAtt: [], listenAtt: [], quizAns: [], listenAns: [], logins: [] };
async function renderTeacher() {
  if (!S.student || !S.student.is_teacher) return;
  try {
    const [students, wprogAll, lprogAll, quizAtt, listenAtt, quizAns, listenAns, logins] = await Promise.all([
      sb("students?select=*&order=id&limit=100"),
      sb("word_progress?select=*&limit=10000"),
      sb("listening_progress?select=*&limit=10000"),
      sb("quiz_attempts?select=*&order=created_at.desc&limit=500"),
      sb("listening_attempts?select=*&order=created_at.desc&limit=500"),
      sb("quiz_answers?select=attempt_id,word_id,correct&correct=eq.false&limit=2000"),
      sb("listening_answers?select=attempt_id,word_id,correct&correct=eq.false&limit=2000"),
      sb("login_history?select=*&order=logged_in_at.desc&limit=1000")
    ]);
    T = { students: students || [], wprogAll: wprogAll || [], lprogAll: lprogAll || [], quizAtt: quizAtt || [], listenAtt: listenAtt || [], quizAns: quizAns || [], listenAns: listenAns || [], logins: logins || [] };
  } catch (e) {
    $("teacher-students").innerHTML = '<p class="err">看板数据加载失败：' + esc(e.message) + "</p>";
    return;
  }
  const wordById = {}; S.words.forEach(w => wordById[w.id] = w);
  const lwordById = {}; Object.values(S.lwordsBySet).flat().forEach(w => lwordById[w.id] = w);
  const now = new Date();
  const nudge = [];
  const rows = T.students.map(st => {
    const wp = T.wprogAll.filter(p => p.student_id === st.id);
    const lp = T.lprogAll.filter(p => p.student_id === st.id);
    const due = wp.filter(p => isDue(p.next_review_at)).length + lp.filter(p => isDue(p.next_review_at)).length;
    const overdue = wp.filter(p => p.next_review_at && new Date(p.next_review_at) < new Date(now - 86400000)).length +
      lp.filter(p => p.next_review_at && new Date(p.next_review_at) < new Date(now - 86400000)).length;
    const tiers = [1, 2, 3].map(t => {
      const list = S.words.filter(w => w.tier === t);
      const known = list.filter(w => { const p = wp.find(x => x.word_id === w.id); return p && p.state === "known"; }).length;
      return "第" + t + "类 " + known + "/" + list.length;
    }).join(" · ");
    const qa = T.quizAtt.filter(a => a.student_id === st.id);
    const la = T.listenAtt.filter(a => a.student_id === st.id);
    const qAvg = qa.length ? Math.round(qa.reduce((s, a) => s + (a.total ? a.correct / a.total : 0), 0) / qa.length * 100) + "%（" + qa.length + "次）" : "—";
    const lAvg = la.length ? Math.round(la.reduce((s, a) => s + (a.total ? a.correct / a.total : 0), 0) / la.length * 100) + "%（" + la.length + "次）" : "—";
    const wrongWords = [];
    T.quizAns.filter(a => qa.some(x => x.id === a.attempt_id) && a.word_id && wordById[a.word_id]).forEach(a => wrongWords.push(wordById[a.word_id].word));
    T.listenAns.filter(a => la.some(x => x.id === a.attempt_id) && a.word_id && lwordById[a.word_id]).forEach(a => wrongWords.push(lwordById[a.word_id].word));
    const reasons = [];
    if (!st.login_count) reasons.push("从没登录");
    else if (st.last_login_at && (now - new Date(st.last_login_at)) > 7 * 86400000) reasons.push("7 天以上没登录");
    if (due >= 10) reasons.push("到期积压 " + due + " 词");
    if (reasons.length && !st.is_teacher) nudge.push({ name: st.name, reasons });
    return { st, tiers, due, overdue, qAvg, lAvg, wrong: [...new Set(wrongWords)].slice(0, 12) };
  });
  $("nudge-list").innerHTML = nudge.length
    ? '<p><b>需要单独提醒（' + nudge.length + ' 人）：</b></p>' + nudge.map(n => "<p>· " + esc(n.name) + " —— " + esc(n.reasons.join("；")) + "</p>").join("")
    : '<p class="ok-msg">没有需要单独提醒的学生，大家都在跟上进度 🎉</p>';
  $("teacher-students").innerHTML = rows.length ? "<table><tr><th>学生</th><th>登录</th><th>最后登录</th><th>三类掌握</th><th>测验平均</th><th>听写平均</th><th>到期 / 过期</th><th>错词</th></tr>" +
    rows.map(r => "<tr><td>" + esc(r.st.name) + (r.st.is_teacher ? "（老师）" : "") + (r.st.disabled ? "（已停用）" : "") + "</td><td>" + (r.st.login_count || 0) + " 次</td><td>" + fmtDate(r.st.last_login_at) + "</td><td>" + esc(r.tiers) + "</td><td>" + esc(r.qAvg) + "</td><td>" + esc(r.lAvg) + "</td><td>" + r.due + " / " + r.overdue + "</td><td>" + (r.wrong.length ? esc(r.wrong.join("、")) : "—") + "</td></tr>").join("") + "</table>"
    : '<p class="muted">还没有学生账号。</p>';
  // 全班错词
  const wrongCount = {};
  T.quizAns.forEach(a => { if (a.word_id && wordById[a.word_id]) wrongCount[wordById[a.word_id].word] = (wrongCount[wordById[a.word_id].word] || 0) + 1; });
  T.listenAns.forEach(a => { if (a.word_id && lwordById[a.word_id]) wrongCount[lwordById[a.word_id].word] = (wrongCount[lwordById[a.word_id].word] || 0) + 1; });
  const top = Object.entries(wrongCount).sort((a, b) => b[1] - a[1]).slice(0, 20);
  $("teacher-wrong").innerHTML = top.length
    ? top.map(([w, c]) => '<span class="pill">' + esc(w) + " ×" + c + "</span>").join("")
    : '<p class="muted">还没有错词记录。</p>';
  // 每次登录 + 每次测验（各取最近 10 次）
  const histEl = $("teacher-history");
  if (histEl) {
    const quizMode = { gloss: "释义", synonym: "同义", sentence: "例句", review: "错词重练" };
    const listenMode = { sequential: "顺序", random: "随机", due: "到期复习" };
    const acc = a => a.total ? Math.round(a.correct / a.total * 100) + "%" : "—";
    histEl.innerHTML = T.students.map(st => {
      const logins = T.logins.filter(l => l.student_id === st.id).slice(0, 10);
      const qa = T.quizAtt.filter(a => a.student_id === st.id).slice(0, 10);
      const la = T.listenAtt.filter(a => a.student_id === st.id).slice(0, 10);
      const loginHtml = logins.length ? logins.map(l => "<li>" + fmtDate(l.logged_in_at) + "</li>").join("") : "<li class='muted'>新功能上线后还没有登录记录</li>";
      const quizHtml = qa.length ? qa.map(a => "<li>" + fmtDate(a.created_at) + " · 测验（" + esc(quizMode[a.mode] || a.mode) + "） " + a.correct + "/" + a.total + " · " + acc(a) + "</li>").join("") : "<li class='muted'>还没有测验记录</li>";
      const listenHtml = la.length ? la.map(a => { const label = (S.sets.find(s => s.id === a.set_id) || {}).label || a.set_id; return "<li>" + fmtDate(a.created_at) + " · 听写（" + esc(label) + " · " + esc(listenMode[a.mode] || a.mode) + "） " + a.correct + "/" + a.total + " · " + acc(a) + "</li>"; }).join("") : "<li class='muted'>还没有听写记录</li>";
      return "<div style='border-top:1px solid var(--line);padding-top:10px;margin-top:10px'><h4 style='margin:0 0 6px'>" + esc(st.name) + (st.is_teacher ? "（老师）" : "") + "</h4><p class='muted' style='margin:4px 0'>最近登录（最多 10 次）：</p><ul>" + loginHtml + "</ul><p class='muted' style='margin:4px 0'>最近测验（最多 10 次）：</p><ul>" + quizHtml + "</ul><p class='muted' style='margin:4px 0'>最近听写（最多 10 次）：</p><ul>" + listenHtml + "</ul></div>";
    }).join("");
  }
  const sel = $("manage-student");
  sel.innerHTML = T.students.filter(s => !s.is_teacher).map(s => '<option value="' + s.id + '">' + esc(s.name) + "（" + esc(s.code) + "）" + (s.disabled ? " · 已停用" : "") + "</option>").join("");
}
let editingWord = null, editingEx = null;
$("btn-load-word").addEventListener("click", async () => {
  const num = parseInt($("edit-word-num").value, 10);
  const rows = await sb("words?num=eq." + num + "&select=*");
  if (!rows || !rows.length) { $("edit-word-msg").innerHTML = '<p class="err">没有找到编号 ' + num + " 的词。</p>"; return; }
  editingWord = rows[0];
  $("edit-word-word").value = editingWord.word || "";
  $("edit-word-pos").value = editingWord.pos || "";
  $("edit-word-meaning").value = editingWord.meaning_zh || "";
  $("edit-word-syn").value = (editingWord.synonyms || []).join(", ");
  $("edit-word-tier").value = String(editingWord.tier);
  $("edit-word-form").classList.remove("hidden");
  $("edit-word-msg").innerHTML = "";
});
$("btn-save-word").addEventListener("click", async () => {
  if (!editingWord) return;
  const body = { word: $("edit-word-word").value.trim(), pos: $("edit-word-pos").value.trim(),
    meaning_zh: $("edit-word-meaning").value.trim(),
    synonyms: $("edit-word-syn").value.split(",").map(s => s.trim()).filter(Boolean),
    tier: parseInt($("edit-word-tier").value, 10) };
  try {
    await sb("words?id=eq." + editingWord.id, "PATCH", body);
    $("edit-word-msg").innerHTML = '<p class="ok-msg">已保存。</p>';
    const i = S.words.findIndex(w => w.id === editingWord.id);
    if (i >= 0) S.words[i] = Object.assign({}, S.words[i], body);
  } catch (e) { $("edit-word-msg").innerHTML = '<p class="err">保存失败：' + esc(e.message) + "</p>"; }
});
$("btn-load-ex").addEventListener("click", async () => {
  const id = parseInt($("edit-ex-num").value, 10);
  const rows = await sb("examples?id=eq." + id + "&select=*");
  if (!rows || !rows.length) { $("edit-ex-msg").innerHTML = '<p class="err">没有找到 ID ' + id + " 的例句。</p>"; return; }
  editingEx = rows[0];
  $("edit-ex-stem").value = editingEx.stem || "";
  $("edit-ex-passage").value = editingEx.passage || "";
  $("edit-ex-question").value = editingEx.question || "";
  $("edit-ex-answer").value = editingEx.answer || "";
  $("edit-ex-expl").value = editingEx.explanation || "";
  $("edit-ex-form").classList.remove("hidden");
  $("edit-ex-msg").innerHTML = "";
});
$("btn-save-ex").addEventListener("click", async () => {
  if (!editingEx) return;
  const body = { stem: $("edit-ex-stem").value, passage: $("edit-ex-passage").value, question: $("edit-ex-question").value,
    answer: $("edit-ex-answer").value.trim(), explanation: $("edit-ex-expl").value };
  try {
    await sb("examples?id=eq." + editingEx.id, "PATCH", body);
    $("edit-ex-msg").innerHTML = '<p class="ok-msg">已保存。</p>';
    const i = S.examples.findIndex(e => e.id === editingEx.id);
    if (i >= 0) S.examples[i] = Object.assign({}, S.examples[i], body);
  } catch (e) { $("edit-ex-msg").innerHTML = '<p class="err">保存失败：' + esc(e.message) + "</p>"; }
});
$("btn-disable-student").addEventListener("click", async () => {
  const id = $("manage-student").value;
  const st = T.students.find(s => String(s.id) === String(id));
  if (!st) return;
  if (!confirm("确定要停用 " + st.name + " 的学习码吗？该学生将无法登录。")) return;
  try {
    await sb("students?id=eq." + id, "PATCH", { disabled: true });
    $("manage-msg").innerHTML = '<p class="ok-msg">已停用 ' + esc(st.name) + " 的学习码。</p>";
    renderTeacher();
  } catch (e) { $("manage-msg").innerHTML = '<p class="err">操作失败：' + esc(e.message) + "</p>"; }
});
$("btn-add-reminder").addEventListener("click", async () => {
  const id = $("manage-student").value;
  const note = $("reminder-note").value.trim();
  if (!note) { $("manage-msg").innerHTML = '<p class="err">请先写提醒内容。</p>'; return; }
  try {
    await sb("reminders", "POST", { student_id: parseInt(id, 10), note });
    $("manage-msg").innerHTML = '<p class="ok-msg">提醒已记入。</p>';
    $("reminder-note").value = "";
  } catch (e) { $("manage-msg").innerHTML = '<p class="err">保存失败：' + esc(e.message) + "</p>"; }
});
/* ---- 新建学生账号 ---- */
function genStudentCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 I、O、0、1
  let code = "STU-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
$("btn-create-student").addEventListener("click", async () => {
  const name = $("new-student-name").value.trim();
  const msg = $("create-student-msg");
  if (!name) { msg.innerHTML = '<p class="err">请先输入学生姓名。</p>'; return; }
  const btn = $("btn-create-student"); btn.disabled = true;
  msg.innerHTML = "";
  let created = null, lastErr = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      const res = await sb("students", "POST", { name, code: genStudentCode(), is_teacher: false }, "return=representation");
      created = Array.isArray(res) ? res[0] : res;
    } catch (e) {
      lastErr = e;
      if (!/409/.test(e.message)) break; // 409 是学习码重复，换一个再试；其他错误直接停
    }
  }
  btn.disabled = false;
  if (!created) {
    msg.innerHTML = '<p class="err">生成失败，请稍后再试' + (lastErr ? "（" + esc(lastErr.message) + "）" : "") + "。</p>";
    return;
  }
  msg.innerHTML = '<p class="ok-msg">已为 ' + esc(name) + ' 生成学习码：<b>' + esc(created.code) + '</b>，请把这个码发给学生登录。</p>';
  $("new-student-name").value = "";
  renderTeacher();
});
