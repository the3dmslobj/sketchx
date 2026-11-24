// sketchX: game loop, drawing, live AI predictions, scoring.
(function () {
  const ROUNDS = 5;
  // time: seconds per round. threshold: AI confidence needed for a match.
  // temperature: > 1 softens the model's scores so only clearer drawings reach the threshold.
  // holdMs: how long the match must stay above the threshold.
  // Measured on real Quick, Draw! doodles, about 67% / 53% / 33% of them pass each level.
  const LEVELS = {
    easy: { name: "Easy", time: 25, threshold: 0.6, temperature: 1, holdMs: 300 },
    normal: { name: "Normal", time: 20, threshold: 0.8, temperature: 1, holdMs: 500 },
    hard: { name: "Hard", time: 15, threshold: 0.85, temperature: 1.2, holdMs: 750 },
  };
  // The model knows these, but they are too rarely recognized to be fair as prompts.
  const NOT_PROMPTS = new Set(["bear", "bird", "violin", "duck"]);
  let level = LEVELS[localStorage.getItem("sketchx.level")] || LEVELS.normal; // picked on the start screen
  let playLevel = level; // level of the game being played (a room can set its own)
  const BASE_POINTS = 500;
  const POINTS_PER_SECOND = 50; // bonus for every second left on the clock
  const PREDICT_EVERY_MS = 200;

  const RANKS = [
    { min: 6001, name: "AI Whisperer", hint: "The network understands you perfectly. Top rank unlocked!" },
    { min: 3500, name: "Pixel Pro", hint: "Score over 6000 to become an AI Whisperer." },
    { min: 1500, name: "Sketch Cadet", hint: "Draw faster and simpler. Score over 6000 for the top rank." },
    { min: 0, name: "Doodle Rookie", hint: "Tip: draw the most iconic shape first. The AI learned from millions of quick doodles." },
  ];

  const ICON_SOUND = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
  const ICON_MUTED = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("startScreen"), game: $("gameScreen"), summary: $("summaryScreen"), room: $("roomScreen"), boardScr: $("boardScreen"),
    startBtn: $("startBtn"), modelInfo: $("modelInfo"), hudRound: $("hudRound"), hudScore: $("hudScore"),
    roundNum: $("roundNum"), score: $("score"), prompt: $("prompt"), timeLeft: $("timeLeft"), timerBar: $("timerBar"),
    board: $("board"), overlay: $("overlay"), overlayTitle: $("overlayTitle"), overlaySub: $("overlaySub"),
    nextBtn: $("nextBtn"), clearBtn: $("clearBtn"), undoBtn: $("undoBtn"), skipBtn: $("skipBtn"),
    guesses: $("guesses"), aiThought: $("aiThought"), aiDot: $("aiDot"), aiStatusText: $("aiStatusText"),
    aiEye: $("aiEye"), muteBtn: $("muteBtn"), finalScore: $("finalScore"), finalRank: $("finalRank"),
    rankHint: $("rankHint"), roundCards: $("roundCards"), againBtn: $("againBtn"),
    statMatched: $("statMatched"), statAvg: $("statAvg"), statBest: $("statBest"),
  };
  el.muteBtn.innerHTML = ICON_SOUND;

  // ---------- Difficulty ----------
  const levelButtons = [...document.querySelectorAll("[data-level]")];
  function setLevel(key) {
    level = LEVELS[key];
    localStorage.setItem("sketchx.level", key);
    for (const b of levelButtons) {
      const on = b.dataset.level === key;
      b.setAttribute("aria-pressed", on);
      b.classList.toggle("bg-white", on); b.classList.toggle("shadow-sm", on); b.classList.toggle("text-neutral-900", on);
      b.classList.toggle("text-neutral-500", !on);
    }
    $("levelHint").textContent = `${level.time} seconds per drawing · AI must be ${Math.round(level.threshold * 100)}% sure`;
    $("roomCreateLevel").textContent = level.name;
    updateDailyButton();
  }
  for (const b of levelButtons) b.addEventListener("click", () => setLevel(b.dataset.level));

  // ---------- Model ----------
  let cnn = null;
  try {
    cnn = new SketchCNN(window.SKETCH_MODEL);
    el.startBtn.disabled = $("dailyBtn").disabled = $("roomBtn").disabled = false;
    el.startBtn.textContent = "Play solo";
    el.modelInfo.textContent = `AI knows ${cnn.classes.length} objects · validation accuracy ${(window.SKETCH_MODEL.valAccuracy * 100).toFixed(1)}%`;
  } catch (e) {
    el.startBtn.textContent = "Model missing";
    el.modelInfo.textContent = "Could not load model.js. Run training/train.py first.";
    console.error(e);
  }

  // ---------- State ----------
  let state = null;
  const newState = (prompts) => ({
    prompts,
    round: 0, score: 0, results: [],
    strokes: [], drawing: false, active: false,
    startTime: 0, raf: 0, lastPredict: 0, lastTickSec: null, best: null, lastTop: null, matchSince: null,
  });

  function shuffle(a, rnd = Math.random) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  // Seeded RNG so every player in a room, or everyone on the same day, gets the same prompts.
  function mulberry32(a) {
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pickPrompts = (seed) =>
    shuffle(cnn.classes.filter((c) => !NOT_PROMPTS.has(c)), seed === undefined ? Math.random : mulberry32(seed)).slice(0, ROUNDS);
  const today = () => new Date().toISOString().slice(0, 10); // UTC, same as the server
  const daySeed = (day) => [...day].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const label = (c) => c[0].toUpperCase() + c.slice(1);
  // "a cat", "an owl", "The Eiffel Tower", "headphones"
  const withArticle = (c) => /^the /i.test(c) ? c : /^(headphones|eyeglasses|drums|grapes|scissors|broccoli)$/.test(c) ? c : (/^[aeiou]/i.test(c) ? "an " : "a ") + c;
  const show = (screen) => {
    for (const s of [el.start, el.game, el.summary, el.room, el.boardScr]) s.classList.toggle("hidden", s !== screen);
    el.hudRound.classList.toggle("hidden", screen !== el.game);
    el.hudScore.classList.toggle("hidden", screen !== el.game && screen !== el.summary);
  };

  // ---------- Canvas drawing ----------
  const g = el.board.getContext("2d");
  function resizeBoard() {
    const r = el.board.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    el.board.width = Math.round(r.width * dpr);
    el.board.height = Math.round(r.height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  function redraw() {
    const r = el.board.getBoundingClientRect();
    g.clearRect(0, 0, r.width, r.height);
    g.strokeStyle = "#171717"; g.lineWidth = Math.max(4, r.width / 120); g.lineCap = "round"; g.lineJoin = "round";
    for (const s of state ? state.strokes : []) {
      g.beginPath();
      s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      if (s.length === 1) g.lineTo(s[0].x + 0.1, s[0].y);
      g.stroke();
    }
  }
  const pos = (e) => { const r = el.board.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  el.board.addEventListener("pointerdown", (e) => {
    if (!state || !state.active) return;
    e.preventDefault();
    el.board.setPointerCapture(e.pointerId);
    state.drawing = true;
    state.strokes.push([pos(e)]);
    Sfx.stroke();
    redraw();
  });
  el.board.addEventListener("pointermove", (e) => {
    if (!state || !state.drawing) return;
    const p = pos(e), s = state.strokes[state.strokes.length - 1], last = s[s.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
    s.push(p);
    redraw();
  });
  const endStroke = () => { if (state && state.drawing) { state.drawing = false; predict(true); } };
  el.board.addEventListener("pointerup", endStroke);
  el.board.addEventListener("pointercancel", endStroke);
  window.addEventListener("resize", () => state && resizeBoard());

  // ---------- AI ----------
  function inkLength() {
    let len = 0;
    for (const s of state.strokes) for (let i = 1; i < s.length; i++) len += Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y);
    return len;
  }

  function predict(force) {
    if (!state.active) return;
    const now = performance.now();
    if (!force && now - state.lastPredict < PREDICT_EVERY_MS) return;
    state.lastPredict = now;
    if (inkLength() < 30) { state.matchSince = null; renderGuesses(null); return; }
    const px = rasterizeStrokes(state.strokes);
    if (!px) return;
    drawEye(px);
    const preds = cnn.predict(px, playLevel.temperature);
    renderGuesses(preds);
    const target = state.prompts[state.round];
    const pTarget = preds.find((p) => p.label === target).p;
    if (!state.best || pTarget > state.best.pTarget) state.best = { pTarget, top: preds[0] };
    if (preds[0].label !== state.lastTop) { state.lastTop = preds[0].label; Sfx.guess(); }
    if (preds[0].label === target && preds[0].p >= playLevel.threshold) {
      if (state.matchSince === null) state.matchSince = now;
      else if (now - state.matchSince >= playLevel.holdMs) endRound(true, preds[0].p);
    } else {
      state.matchSince = null;
    }
  }

  function drawEye(px) {
    const c = el.aiEye.getContext("2d");
    const img = c.createImageData(28, 28);
    for (let i = 0; i < 784; i++) {
      const v = 255 - Math.round(px[i] * 232); // dark ink on white
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }

  function renderGuesses(preds) {
    const target = state.prompts[state.round];
    if (!preds) {
      el.guesses.innerHTML = "";
      el.aiThought.textContent = "Start drawing…";
      setStatus("waiting", "bg-neutral-300");
      return;
    }
    const top = preds[0];
    const name = top.label;
    el.aiThought.textContent =
      top.p >= playLevel.threshold ? `Oh I know, it's ${withArticle(name)}!` :
      top.p >= 0.4 ? `I think it's ${withArticle(name)}…` :
      top.p >= 0.2 ? `Is it ${withArticle(name)}?` : "Hmm… not sure yet";
    setStatus("thinking", "bg-neutral-900 animate-pulse");
    el.guesses.innerHTML = preds.slice(0, 3).map((p, i) => {
      const pct = Math.round(p.p * 100);
      const hit = p.label === target;
      const bar = hit ? "bg-emerald-500" : i === 0 ? "bg-neutral-900" : "bg-neutral-300";
      return `<li>
        <div class="flex justify-between text-sm mb-1">
          <span class="${hit ? "text-emerald-600 font-medium" : "text-neutral-700"}">${label(p.label)}${hit ? " ✓" : ""}</span>
          <span class="tabular-nums text-neutral-400">${pct}%</span>
        </div>
        <div class="h-1 rounded-full bg-neutral-100 overflow-hidden"><div class="bar h-full ${bar}" style="width:${pct}%"></div></div>
      </li>`;
    }).join("");
  }
  function setStatus(text, dot) { el.aiStatusText.textContent = text; el.aiDot.className = `w-1.5 h-1.5 rounded-full ${dot}`; }

  // ---------- Game flow ----------
  // mode: "solo" (all-time board), "daily" (today's prompts, daily board) or "room".
  let mode = "solo";
  let countdownTimer = 0;
  function startGame(opts = {}) {
    Sfx.unlock();
    mode = opts.mode || "solo";
    playLevel = opts.level || level;
    if (state) { state.active = false; cancelAnimationFrame(state.raf); }
    clearInterval(countdownTimer);
    state = newState(opts.prompts || pickPrompts());
    $("thresholdLabel").textContent = Math.round(playLevel.threshold * 100);
    $("hudLevel").textContent = playLevel.name + (mode === "daily" ? " · Daily" : mode === "room" ? ` · Room ${room.code}` : "");
    $("summaryLevel").textContent = playLevel.name + (mode === "daily" ? " · Daily challenge" : mode === "room" ? ` · Room ${room.code}` : "");
    $("roomPanel").classList.toggle("hidden", mode !== "room");
    el.score.textContent = "0";
    el.overlay.classList.add("hidden");
    show(el.game);
    resizeBoard();
    if (!opts.at || opts.at <= Date.now()) { $("countdown").classList.add("hidden"); startRound(); return; }
    // Rooms: everyone starts at the same moment, after a short countdown.
    el.prompt.textContent = "Get ready";
    el.timeLeft.textContent = playLevel.time.toFixed(1);
    el.roundNum.textContent = 1;
    renderGuesses(null);
    redraw();
    $("countdown").classList.remove("hidden");
    const tickDown = () => {
      const ms = opts.at - Date.now();
      if (ms <= 0) { clearInterval(countdownTimer); $("countdown").classList.add("hidden"); startRound(); return; }
      $("countdownNum").textContent = Math.ceil(ms / 1000);
    };
    tickDown();
    countdownTimer = setInterval(tickDown, 100);
  }

  function startRound() {
    Object.assign(state, { strokes: [], drawing: false, active: true, best: null, lastTop: null, lastTickSec: null, lastPredict: 0, matchSince: null });
    const target = state.prompts[state.round];
    el.roundNum.textContent = state.round + 1;
    el.prompt.textContent = label(target);
    el.timeLeft.textContent = playLevel.time.toFixed(1);
    el.timeLeft.classList.remove("text-red-600");
    el.timerBar.style.width = "100%";
    el.prompt.classList.remove("pop"); void el.prompt.offsetWidth; el.prompt.classList.add("pop");
    el.overlay.classList.add("hidden");
    el.aiEye.getContext("2d").clearRect(0, 0, 28, 28);
    renderGuesses(null);
    redraw();
    Sfx.start();
    state.startTime = performance.now();
    cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(tick);
  }

  function tick() {
    if (!state.active) return;
    const elapsed = (performance.now() - state.startTime) / 1000;
    const left = Math.max(0, playLevel.time - elapsed);
    el.timeLeft.textContent = left.toFixed(1);
    el.timeLeft.classList.toggle("text-red-600", left <= 5);
    el.timerBar.classList.toggle("bg-red-600", left <= 5);
    el.timerBar.classList.toggle("bg-neutral-900", left > 5);
    el.timerBar.style.width = `${(left / playLevel.time) * 100}%`;
    const sec = Math.ceil(left);
    if (sec !== state.lastTickSec && sec <= 5 && sec > 0) { sec <= 3 ? Sfx.urgent() : Sfx.tick(); }
    state.lastTickSec = sec;
    predict(false); // also runs between strokes so a held match can complete
    if (left <= 0) return endRound(false);
    state.raf = requestAnimationFrame(tick);
  }

  function endRound(matched, confidence = 0, skipped = false) {
    if (!state.active) return;
    state.active = false;
    state.drawing = false;
    cancelAnimationFrame(state.raf);
    const elapsed = Math.min(playLevel.time, (performance.now() - state.startTime) / 1000);
    const left = playLevel.time - elapsed;
    const target = state.prompts[state.round];
    const bonus = matched ? Math.round(left * POINTS_PER_SECOND) : 0;
    const points = matched ? BASE_POINTS + bonus : 0;
    state.score += points;
    state.results.push({
      target, matched, skipped, time: elapsed, points, confidence,
      aiGuess: state.best ? state.best.top.label : null,
      image: snapshot(),
    });
    el.score.textContent = state.score;

    if (matched) {
      Sfx.match();
      setStatus("match", "bg-emerald-500");
      el.overlayTitle.className = "text-3xl font-semibold tracking-tight mb-2 text-emerald-600";
      el.overlayTitle.textContent = "Match";
      el.overlaySub.innerHTML = `${Math.round(confidence * 100)}% sure in ${elapsed.toFixed(1)}s<br>
        <span class="text-neutral-900 font-medium tabular-nums">+${points}</span> <span class="text-neutral-400">(${BASE_POINTS} + ${bonus} speed bonus)</span>`;
    } else {
      Sfx.fail();
      setStatus(skipped ? "skipped" : "time up", "bg-red-500");
      el.overlayTitle.className = "text-3xl font-semibold tracking-tight mb-2";
      el.overlayTitle.textContent = skipped ? "Skipped" : "Time's up";
      el.overlaySub.textContent = state.best ? `The AI thought it looked like ${withArticle(state.best.top.label)}.` : "The AI didn't see anything to guess.";
      el.board.parentElement.classList.add("shake");
      setTimeout(() => el.board.parentElement.classList.remove("shake"), 700);
    }
    el.nextBtn.textContent = state.round + 1 >= ROUNDS ? "See results" : "Next round";
    el.overlay.classList.remove("hidden");
    if (mode === "room") sendRoomProgress(state.round + 1 >= ROUNDS);
  }

  function snapshot() {
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, 160, 160);
    // Re-draw the vector strokes, fitted to the thumbnail.
    const pts = state.strokes.flat();
    if (!pts.length) return c.toDataURL();
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const s = 130 / Math.max(maxX - minX, maxY - minY, 1);
    const ox = (160 - (maxX - minX) * s) / 2 - minX * s, oy = (160 - (maxY - minY) * s) / 2 - minY * s;
    x.strokeStyle = "#171717"; x.lineWidth = 3; x.lineCap = "round"; x.lineJoin = "round";
    for (const st of state.strokes) {
      x.beginPath();
      st.forEach((p, i) => (i ? x.lineTo(p.x * s + ox, p.y * s + oy) : x.moveTo(p.x * s + ox, p.y * s + oy)));
      x.stroke();
    }
    return c.toDataURL();
  }

  function next() {
    state.round++;
    if (state.round >= ROUNDS) showSummary();
    else startRound();
  }

  function showSummary() {
    show(el.summary);
    const r = state.results;
    const matched = r.filter((x) => x.matched);
    const rank = RANKS.find((k) => state.score >= k.min);
    el.finalScore.textContent = state.score;
    el.finalRank.textContent = rank.name;
    el.rankHint.textContent = rank.hint;
    el.statMatched.textContent = `${matched.length}/${ROUNDS}`;
    el.statAvg.textContent = matched.length ? `${(matched.reduce((a, b) => a + b.time, 0) / matched.length).toFixed(1)}s` : "–";
    el.statBest.textContent = matched.length ? `${Math.min(...matched.map((x) => x.time)).toFixed(1)}s` : "–";
    el.roundCards.innerHTML = r.map((x, i) => `
      <div class="rounded-xl border border-neutral-200 bg-white p-3">
        <img src="${x.image}" alt="Your ${x.target} sketch" class="w-full rounded-md mb-3" />
        <div class="flex items-baseline justify-between gap-2">
          <div class="text-sm font-medium">${label(x.target)}</div>
          <div class="text-sm tabular-nums ${x.points ? "text-neutral-900" : "text-neutral-400"}">+${x.points}</div>
        </div>
        <div class="text-xs mt-0.5 ${x.matched ? "text-emerald-600" : "text-neutral-400"}">
          ${x.matched ? `${x.time.toFixed(1)}s · ${Math.round(x.confidence * 100)}%` : x.skipped ? "Skipped" : "Not recognized"}
        </div>
        ${!x.matched && x.aiGuess ? `<div class="text-xs text-neutral-400">AI saw: ${x.aiGuess}</div>` : ""}
      </div>`).join("");
    if (rank.min > 6000) Sfx.fanfare(); else Sfx.match();
    showOnlineResult();
  }

  // ---------- Player ----------
  const playerId = localStorage.getItem("sketchx.player") || crypto.randomUUID();
  localStorage.setItem("sketchx.player", playerId);
  const nameInput = $("nameInput");
  nameInput.value = localStorage.getItem("sketchx.name") || "";
  nameInput.addEventListener("input", () => {
    localStorage.setItem("sketchx.name", nameInput.value.trim());
    $("nameHint").textContent = "Shown on leaderboards and in rooms";
    $("nameHint").classList.remove("text-red-600");
  });
  const playerName = () => nameInput.value.trim().slice(0, 16);
  function requireName() {
    if (playerName()) return true;
    $("nameHint").textContent = "Enter a name first";
    $("nameHint").classList.add("text-red-600");
    nameInput.focus();
    return false;
  }

  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  // One row of a ranking list.
  const row = (rank, name, right, { me = false, sub = "" } = {}) => `
    <li class="flex items-center gap-3 px-4 py-2.5 ${me ? "bg-neutral-50" : ""}">
      <span class="w-6 text-sm tabular-nums text-neutral-400">${rank}</span>
      <span class="flex-1 min-w-0 truncate text-sm ${me ? "font-medium" : ""}">${esc(name)}${me ? ' <span class="text-neutral-400 font-normal">(you)</span>' : ""}${sub ? ` <span class="text-xs text-neutral-400">${sub}</span>` : ""}</span>
      <span class="text-sm tabular-nums">${right}</span>
    </li>`;
  const emptyRow = (text) => `<li class="px-4 py-6 text-center text-sm text-neutral-400">${text}</li>`;

  // ---------- Daily challenge ----------
  const dailyKey = (lv) => `sketchx.daily.${today()}.${lv}`;
  const levelKey = (lv) => Object.keys(LEVELS).find((k) => LEVELS[k] === lv);
  function updateDailyButton() {
    const played = localStorage.getItem(dailyKey(levelKey(level)));
    $("dailyBtn").textContent = played === null ? "Daily challenge" : `Daily challenge ✓ ${played}`;
  }
  $("dailyBtn").addEventListener("click", () => {
    if (localStorage.getItem(dailyKey(levelKey(level))) !== null) return openBoard("daily", levelKey(level));
    if (!requireName()) return;
    startGame({ mode: "daily", prompts: pickPrompts(daySeed(today())) });
  });

  // ---------- Leaderboard ----------
  let boardView = { board: "daily", level: "normal" };
  function paintToggles() {
    for (const b of document.querySelectorAll("[data-board]")) {
      const on = b.dataset.board === boardView.board;
      b.classList.toggle("bg-white", on); b.classList.toggle("shadow-sm", on); b.classList.toggle("text-neutral-500", !on);
    }
    for (const b of document.querySelectorAll("[data-board-level]")) {
      const on = b.dataset.boardLevel === boardView.level;
      b.classList.toggle("bg-white", on); b.classList.toggle("shadow-sm", on); b.classList.toggle("text-neutral-500", !on);
    }
  }
  async function fetchBoard(board, lv) {
    return api(`/api/scores?board=${board}&level=${lv}&player=${encodeURIComponent(playerId)}`);
  }
  function boardRows(data) {
    if (!data.entries.length) return emptyRow(data.board === "daily" ? "No one has played today's challenge yet." : "No scores yet. Be the first!");
    let html = data.entries.map((e) => row(e.rank, e.name, e.score, { me: e.id === playerId })).join("");
    if (data.me && data.me.rank > data.entries.length) html += row(data.me.rank, playerName() || "You", data.me.score, { me: true });
    return html;
  }
  async function renderBoard() {
    paintToggles();
    const { board, level: lv } = boardView;
    $("boardList").innerHTML = emptyRow("Loading…");
    $("boardNote").textContent = board === "daily"
      ? "Same 5 prompts for everyone today (UTC). Only your first game counts."
      : "Your best solo game counts.";
    try {
      const data = await fetchBoard(board, lv);
      if (boardView.board !== board || boardView.level !== lv) return; // a newer tab was picked meanwhile
      $("boardList").innerHTML = boardRows(data);
    } catch (e) {
      $("boardList").innerHTML = emptyRow(`Couldn't load the leaderboard: ${esc(e.message)}`);
    }
  }
  function openBoard(board = "daily", lv = levelKey(level)) {
    boardView = { board, level: lv };
    show(el.boardScr);
    renderBoard();
  }
  for (const b of document.querySelectorAll("[data-board]")) b.addEventListener("click", () => { boardView.board = b.dataset.board; renderBoard(); });
  for (const b of document.querySelectorAll("[data-board-level]")) b.addEventListener("click", () => { boardView.level = b.dataset.boardLevel; renderBoard(); });
  $("boardBtn").addEventListener("click", () => openBoard());

  // ---------- Rooms ----------
  // room: { code, data (last server state), offset (server clock - local clock), playedGame, poll }
  let room = null;
  const POLL_MS = 1500;
  const isHost = () => room && room.data && room.data.host === playerId;

  function openRooms() {
    if (room) return showLobby();
    $("roomError").textContent = "";
    $("roomJoin").classList.remove("hidden");
    $("roomLobby").classList.add("hidden");
    show(el.room);
  }
  $("roomBtn").addEventListener("click", () => { if (requireName()) openRooms(); });

  async function enterRoom(action, extra) {
    $("roomError").textContent = "";
    try {
      const t0 = Date.now();
      const data = await api("/api/rooms", { action, player: playerId, name: playerName(), ...extra });
      room = { code: data.code, data, offset: data.serverNow - (t0 + Date.now()) / 2, playedGame: data.game, poll: 0 };
      history.replaceState(null, "", `?room=${data.code}`);
      room.poll = setInterval(pollRoom, POLL_MS);
      showLobby();
    } catch (e) {
      $("roomError").textContent = e.message;
    }
  }
  $("createRoomBtn").addEventListener("click", () => enterRoom("create", { level: levelKey(level) }));
  $("joinRoomBtn").addEventListener("click", () => {
    const code = $("codeInput").value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { $("roomError").textContent = "Room codes are 4 letters."; return; }
    enterRoom("join", { code });
  });
  $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinRoomBtn").click(); });

  function leaveRoom(message) {
    if (!room) return;
    clearInterval(room.poll);
    api("/api/rooms", { action: "leave", code: room.code, player: playerId }).catch(() => {});
    room = null;
    history.replaceState(null, "", location.pathname);
    if (state) { state.active = false; cancelAnimationFrame(state.raf); }
    clearInterval(countdownTimer);
    show(el.start);
    if (message) { openRooms(); $("roomError").textContent = message; }
  }
  $("leaveRoomBtn").addEventListener("click", () => leaveRoom());
  $("roomPanelLeave").addEventListener("click", () => leaveRoom());

  async function pollRoom() {
    if (!room) return;
    const code = room.code;
    try {
      const t0 = Date.now();
      const data = await api(`/api/rooms?code=${code}`);
      if (!room || room.code !== code) return;
      room.offset = data.serverNow - (t0 + Date.now()) / 2;
      onRoomData(data);
    } catch (e) {
      if (e.status === 404 && room && room.code === code) leaveRoom("That room has closed.");
    }
  }

  function onRoomData(data) {
    room.data = data;
    if (data.status === "playing" && data.game > room.playedGame) {
      // The host started a game: everyone begins at the same server time.
      room.playedGame = data.game;
      startGame({ mode: "room", level: LEVELS[data.level], prompts: pickPrompts(data.seed), at: data.startAt - room.offset });
    }
    renderRoom();
  }

  function roomStatus(p) {
    const d = room.data;
    if (d.status !== "playing" && !p.round) return p.isHost ? "host" : "";
    return p.done ? "finished" : p.round ? `round ${p.round}/${d.rounds}` : "drawing";
  }
  function roomRows(compact) {
    const players = room.data.players;
    return players.map((p, i) => compact
      ? `<li class="flex items-center gap-2 ${p.id === playerId ? "font-medium" : ""}">
           <span class="w-4 text-neutral-400 tabular-nums">${i + 1}</span>
           <span class="flex-1 min-w-0 truncate">${esc(p.name)}</span>
           <span class="text-xs text-neutral-400">${p.done ? "✓" : `${p.round}/${room.data.rounds}`}</span>
           <span class="w-12 text-right tabular-nums">${p.score}</span>
         </li>`
      : row(i + 1, p.name, room.data.status === "playing" || p.round ? p.score : "", { me: p.id === playerId, sub: roomStatus(p) })).join("");
  }

  function renderRoom() {
    if (!room || !room.data) return;
    const d = room.data, host = isHost();
    // Lobby
    $("lobbyCode").textContent = d.code;
    const lv = LEVELS[d.level];
    $("lobbyLevel").textContent = `${lv.name} · ${lv.time} seconds per drawing · ${d.players.length} player${d.players.length === 1 ? "" : "s"}`;
    $("lobbyPlayers").innerHTML = roomRows(false);
    const running = d.status === "playing" && d.players.some((p) => !p.done);
    $("startRoomBtn").classList.toggle("hidden", !host);
    $("startRoomBtn").textContent = d.game ? "Start next game" : "Start game";
    $("lobbyWait").classList.toggle("hidden", host);
    $("lobbyWait").textContent = running ? "A game is in progress…" : "Waiting for the host to start…";
    // In-game panel
    $("roomPanelCode").textContent = d.code;
    $("roomPanelList").innerHTML = roomRows(true);
    // Summary
    if (mode === "room" && !el.summary.classList.contains("hidden")) renderRoomSummary();
  }

  function showLobby() {
    $("roomJoin").classList.add("hidden");
    $("roomLobby").classList.remove("hidden");
    $("lobbyError").textContent = "";
    show(el.room);
    renderRoom();
  }

  async function hostStart() {
    $("lobbyError").textContent = "";
    try {
      const t0 = Date.now();
      const data = await api("/api/rooms", { action: "start", code: room.code, player: playerId });
      room.offset = data.serverNow - (t0 + Date.now()) / 2;
      onRoomData(data);
    } catch (e) {
      $("lobbyError").textContent = e.message;
    }
  }
  $("startRoomBtn").addEventListener("click", hostStart);

  function sendRoomProgress(done) {
    if (!room) return;
    const matched = state.results.filter((x) => x.matched).length;
    api("/api/rooms", { action: "progress", code: room.code, player: playerId, round: state.results.length, score: state.score, matched, done })
      .then((data) => room && room.code === data.code && onRoomData(data))
      .catch(() => {});
  }

  $("copyLinkBtn").addEventListener("click", async () => {
    const link = `${location.origin}${location.pathname}?room=${room.code}`;
    try { await navigator.clipboard.writeText(link); $("copyLinkBtn").textContent = "Copied"; }
    catch { $("copyLinkBtn").textContent = link; }
    setTimeout(() => ($("copyLinkBtn").textContent = "Copy invite link"), 2000);
  });

  // ---------- Results ----------
  function setOnline(title, note, html) {
    $("summaryOnline").classList.remove("hidden");
    $("summaryOnlineTitle").textContent = title;
    $("summaryOnlineNote").innerHTML = note;
    $("summaryOnlineList").innerHTML = html;
  }

  function renderRoomSummary() {
    const d = room.data, waiting = d.players.filter((p) => !p.done).length;
    setOnline(`Room ${d.code}`, waiting ? `${waiting} still drawing…` : "Everyone finished", roomRows(false));
    const host = isHost();
    el.againBtn.classList.toggle("hidden", !host);
    el.againBtn.textContent = "Start next game";
    $("summaryWait").classList.toggle("hidden", host);
  }

  async function showOnlineResult() {
    $("summaryOnline").classList.add("hidden");
    $("summaryWait").classList.add("hidden");
    el.againBtn.classList.remove("hidden");
    el.homeBtn.textContent = "Home";
    if (mode === "room") {
      el.homeBtn.textContent = "Leave room";
      return renderRoomSummary();
    }
    const board = mode === "daily" ? "daily" : "all";
    const lv = levelKey(playLevel);
    el.againBtn.textContent = mode === "daily" ? "Play solo" : "Play again";
    if (mode === "daily") { localStorage.setItem(dailyKey(lv), state.score); updateDailyButton(); }
    const title = `${board === "daily" ? "Today's challenge" : "All time"} · ${playLevel.name}`;
    if (!playerName()) {
      setOnline(title, "Add your name on the start screen to join the leaderboard.", "");
      return;
    }
    setOnline(title, "Saving…", emptyRow("Loading…"));
    try {
      const res = await api("/api/scores", { board, level: lv, player: playerId, name: playerName(), score: state.score });
      const data = await fetchBoard(board, lv);
      const note = board === "daily" && !res.counted
        ? `Only your first game today counts · you're #${res.rank}`
        : `You're #${res.rank}${board === "all" && res.score > state.score ? ` with your best of ${res.score}` : ""}`;
      setOnline(title, esc(note), boardRows(data));
    } catch (e) {
      setOnline(title, `Couldn't save your score: ${esc(e.message)}`, "");
    }
  }

  el.homeBtn = $("homeBtn");
  el.againBtn.addEventListener("click", () => {
    if (mode === "room") return hostStart();
    startGame({ mode: "solo" });
  });
  el.homeBtn.addEventListener("click", () => (mode === "room" ? leaveRoom() : show(el.start)));
  for (const b of document.querySelectorAll(".backBtn")) b.addEventListener("click", () => (room ? leaveRoom() : show(el.start)));

  // ---------- Buttons ----------
  el.startBtn.addEventListener("click", () => startGame({ mode: "solo" }));
  el.nextBtn.addEventListener("click", next);
  el.clearBtn.addEventListener("click", () => { if (!state.active) return; state.strokes = []; redraw(); renderGuesses(null); });
  el.undoBtn.addEventListener("click", () => { if (!state.active) return; state.strokes.pop(); redraw(); predict(true); });
  el.skipBtn.addEventListener("click", () => state && state.active && endRound(false, 0, true));
  el.muteBtn.addEventListener("click", () => { el.muteBtn.innerHTML = Sfx.toggle() ? ICON_MUTED : ICON_SOUND; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !el.overlay.classList.contains("hidden") && !el.game.classList.contains("hidden")) next();
  });

  setLevel(levelKey(level));
  // Invite links: ?room=ABCD opens the room screen with the code filled in.
  const invited = new URLSearchParams(location.search).get("room");
  if (invited && /^[A-Za-z]{4}$/.test(invited) && cnn) {
    $("codeInput").value = invited.toUpperCase();
    if (playerName()) { openRooms(); enterRoom("join", { code: invited.toUpperCase() }); }
    else { $("nameHint").textContent = `Enter a name to join room ${invited.toUpperCase()}`; $("roomBtn").textContent = `Join room ${invited.toUpperCase()}`; }
  }
})();
