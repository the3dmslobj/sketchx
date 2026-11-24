// sketchX: views, game loop, drawing, live AI predictions, scoring, leaderboards and rooms.
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
  let level = LEVELS[localStorage.getItem("sketchx.level")] || LEVELS.normal; // picked by the player
  let playLevel = level; // level of the game being played (a room can set its own)
  const BASE_POINTS = 500;
  const POINTS_PER_SECOND = 50; // bonus for every second left on the clock
  const PREDICT_EVERY_MS = 200;

  const RANKS = [
    { min: 6001, name: "AI Whisperer", hint: "The network understands you perfectly. Top rank unlocked!" },
    { min: 3500, name: "Pixel Pro", hint: "Score over 6,000 to become an AI Whisperer." },
    { min: 1500, name: "Sketch Cadet", hint: "Draw faster and simpler. Score over 6,000 for the top rank." },
    { min: 0, name: "Doodle Rookie", hint: "Tip: draw the most iconic shape first. The AI learned from millions of quick doodles." },
  ];

  const INK = "#f4f4f5";
  const THUMB_BG = "#111113";

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const el = {
    startBtn: $("startBtn"), prompt: $("prompt"), timeLeft: $("timeLeft"), timerBar: $("timerBar"),
    roundNum: $("roundNum"), score: $("score"), board: $("board"), boardWrap: $("boardWrap"),
    overlay: $("overlay"), overlayTitle: $("overlayTitle"), overlaySub: $("overlaySub"),
    overlayIcon: $("overlayIcon"), overlayPoints: $("overlayPoints"), nextBtn: $("nextBtn"),
    clearBtn: $("clearBtn"), undoBtn: $("undoBtn"), skipBtn: $("skipBtn"),
    guesses: $("guesses"), aiThought: $("aiThought"), aiStatusText: $("aiStatusText"), aiEye: $("aiEye"),
    aiStripText: $("aiStripText"), aiStripPct: $("aiStripPct"),
    finalScore: $("finalScore"), finalRank: $("finalRank"), rankHint: $("rankHint"), roundCards: $("roundCards"),
    againBtn: $("againBtn"), homeBtn: $("homeBtn"),
    statMatched: $("statMatched"), statAvg: $("statAvg"), statBest: $("statBest"),
  };

  const fmt = (n) => Number(n).toLocaleString("en-US");
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const label = (c) => c[0].toUpperCase() + c.slice(1);
  // "a cat", "an owl", "The Eiffel Tower", "headphones"
  const withArticle = (c) => /^the /i.test(c) ? c : /^(headphones|eyeglasses|drums|grapes|scissors|broccoli)$/.test(c) ? c : (/^[aeiou]/i.test(c) ? "an " : "a ") + c;
  const setText = (node, text) => { (node.querySelector("span") || node).textContent = text; };
  const initial = (name) => esc((name.trim()[0] || "?").toUpperCase());

  // ---------- Views ----------
  const VIEWS = {
    play: $("viewPlay"), daily: $("viewDaily"), friends: $("viewFriends"),
    board: $("viewBoard"), results: $("viewResults"), game: $("viewGame"),
  };
  let current = null;
  function go(name) {
    current = name;
    for (const [key, view] of Object.entries(VIEWS)) view.classList.toggle("hidden", key !== name);
    $("shell").classList.toggle("hidden", name === "game");
    for (const b of $$(".nav-item, .tab-item")) {
      const on = b.dataset.nav === name;
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
      const icon = b.querySelector("i[data-icon]");
      icon.className = `${on ? "ph-fill" : "ph"} ph-${icon.dataset.icon}`;
    }
    closePopovers();
    if (name !== "game") {
      const v = VIEWS[name];
      v.classList.remove("enter"); void v.offsetWidth; v.classList.add("enter");
      window.scrollTo(0, 0);
    }
    if (name === "daily") renderDaily();
    if (name === "friends") renderFriends();
  }
  for (const b of $$("[data-nav]")) {
    b.addEventListener("click", () => {
      const to = b.dataset.nav;
      if (to === "board") return openBoard(b.dataset.boardTarget || boardView.board, levelKey(level));
      go(to);
    });
  }

  // ---------- Player name ----------
  const playerId = localStorage.getItem("sketchx.player") || crypto.randomUUID();
  localStorage.setItem("sketchx.player", playerId);
  let name = localStorage.getItem("sketchx.name") || "";
  const playerName = () => name.trim().slice(0, 16);
  function paintName() {
    const n = playerName();
    for (const l of $$(".name-label")) { l.textContent = n || "Add your name"; l.classList.toggle("text-zinc-400", !n); }
    for (const a of $$(".name-avatar")) a.innerHTML = n ? initial(n) : '<i class="ph ph-user text-[13px]"></i>';
  }
  for (const input of $$(".name-field")) {
    input.value = name;
    input.addEventListener("input", () => {
      name = input.value;
      localStorage.setItem("sketchx.name", name.trim());
      for (const other of $$(".name-field")) if (other !== input) other.value = name;
      for (const h of $$(".name-hint")) h.classList.remove("text-red-400");
      paintName();
    });
  }
  // Daily and Friends show a name field when one is needed; it stays while the view is open.
  function paintGate(view, hint) {
    const gate = VIEWS[view].querySelector(".name-gate");
    if (!gate) return;
    if (!playerName()) gate.classList.remove("hidden");
    else if (!hint) gate.classList.add("hidden");
    if (hint) gate.querySelector(".name-hint").textContent = hint;
  }
  function requireName(view) {
    if (playerName()) return true;
    const gate = VIEWS[view] && VIEWS[view].querySelector(".name-gate");
    if (!gate) { $("nameInput").focus(); return false; }
    gate.classList.remove("hidden");
    const hint = gate.querySelector(".name-hint");
    hint.textContent = "Enter a name first";
    hint.classList.add("text-red-400");
    gate.querySelector("input").focus();
    return false;
  }

  // Name popover, opened from the chips in the rail and the mobile header.
  const namePop = $("namePop");
  let namePopFromResults = false;
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".name-chip, .name-cta");
    if (!chip) return;
    if (!namePop.classList.contains("hidden")) return closePopovers();
    namePopFromResults = chip.classList.contains("name-cta");
    namePop.classList.remove("hidden");
    const r = chip.getBoundingClientRect(), h = namePop.offsetHeight, w = namePop.offsetWidth;
    namePop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    namePop.style.top = `${r.top > innerHeight / 2 ? r.top - h - 8 : r.bottom + 8}px`;
    $("namePopInput").focus();
    $("namePopInput").select();
  });
  $("namePopDone").addEventListener("click", closePopovers);
  $("namePopInput").addEventListener("keydown", (e) => { if (e.key === "Enter") closePopovers(); });

  function closePopovers() {
    // A name added from the results screen saves that game's score right away.
    if (namePopFromResults && !namePop.classList.contains("hidden") && playerName() && current === "results" && mode !== "room") showOnlineResult();
    namePopFromResults = false;
    namePop.classList.add("hidden");
    $("exitPop").classList.add("hidden");
    $("roomSheet").classList.add("hidden");
  }
  document.addEventListener("pointerdown", (e) => {
    if (!namePop.classList.contains("hidden") && !namePop.contains(e.target) && !e.target.closest(".name-chip, .name-cta")) closePopovers();
    if (!$("exitPop").classList.contains("hidden") && !e.target.closest("#exitPop, #exitBtn")) $("exitPop").classList.add("hidden");
  });

  // ---------- Difficulty ----------
  const levelKey = (lv) => Object.keys(LEVELS).find((k) => LEVELS[k] === lv);
  for (const card of $$(".level-card")) {
    const lv = LEVELS[card.dataset.level];
    card.classList.add("group");
    card.innerHTML = `
      <i class="ph-fill ph-check-circle absolute top-2.5 right-2.5 text-[15px] text-zinc-100 opacity-0 scale-75 transition group-aria-pressed:opacity-100 group-aria-pressed:scale-100"></i>
      <div class="text-sm font-medium mb-2.5">${lv.name}</div>
      <div class="flex items-center justify-center gap-3 text-[12px] text-zinc-500">
        <span class="flex items-center gap-1"><i class="ph ph-timer"></i><span class="num">${lv.time}s</span></span>
        <span class="flex items-center gap-1"><i class="ph ph-target"></i><span class="num">${Math.round(lv.threshold * 100)}%</span></span>
      </div>`;
    card.title = `${lv.time} seconds per drawing · AI must be ${Math.round(lv.threshold * 100)}% sure`;
  }
  function setLevel(key) {
    level = LEVELS[key];
    localStorage.setItem("sketchx.level", key);
    for (const b of $$("[data-level]")) b.setAttribute("aria-pressed", b.dataset.level === key);
    updateDaily();
  }
  for (const b of $$("[data-level]")) b.addEventListener("click", () => setLevel(b.dataset.level));

  // ---------- Model ----------
  let cnn = null;
  try {
    cnn = new SketchCNN(window.SKETCH_MODEL);
    el.startBtn.disabled = $("dailyBtn").disabled = false;
    setText(el.startBtn, "Play solo");
    $("modelInfo").innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>AI knows <span class="num text-zinc-200">${cnn.classes.length}</span> objects · <span class="num text-zinc-200">${(window.SKETCH_MODEL.valAccuracy * 100).toFixed(1)}%</span> accuracy`;
  } catch (e) {
    setText(el.startBtn, "Model missing");
    $("modelInfo").innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>Could not load model.js. Run training/train.py first.';
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

  // ---------- Canvas drawing ----------
  const g = el.board.getContext("2d");
  function resizeBoard() {
    const r = el.board.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    el.board.width = Math.round(r.width * dpr);
    el.board.height = Math.round(r.height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  function redraw() {
    const r = el.board.getBoundingClientRect();
    g.clearRect(0, 0, r.width, r.height);
    g.strokeStyle = INK; g.lineWidth = Math.max(4, Math.min(r.width, r.height) / 90); g.lineCap = "round"; g.lineJoin = "round";
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
  new ResizeObserver(() => current === "game" && resizeBoard()).observe(el.boardWrap);

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
      const v = 9 + Math.round(px[i] * 235); // light ink on near-black
      img.data[i * 4] = img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = Math.min(255, v + 2); img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }

  const DOT = { idle: "bg-zinc-600", thinking: "bg-zinc-100 animate-pulse", match: "bg-emerald-400", miss: "bg-red-400" };
  function setStatus(text, tone) {
    el.aiStatusText.textContent = text;
    for (const d of $$(".ai-dot")) d.className = `ai-dot w-1.5 h-1.5 rounded-full shrink-0 ${DOT[tone]}`;
  }

  function renderGuesses(preds) {
    const target = state.prompts[state.round];
    if (!preds) {
      el.guesses.innerHTML = `<li class="flex flex-col items-center justify-center h-[132px] text-center text-[13px] text-zinc-600">
        <i class="ph ph-pencil-simple-line text-[22px] mb-2"></i>Guesses appear as you draw</li>`;
      el.aiThought.textContent = "Start drawing…";
      el.aiStripText.textContent = "Start drawing…";
      el.aiStripPct.textContent = "";
      setStatus("waiting", "idle");
      return;
    }
    const top = preds[0];
    const thought =
      top.p >= playLevel.threshold ? `Oh I know, it's ${withArticle(top.label)}!` :
      top.p >= 0.4 ? `I think it's ${withArticle(top.label)}…` :
      top.p >= 0.2 ? `Is it ${withArticle(top.label)}?` : "Hmm… not sure yet";
    el.aiThought.textContent = thought;
    el.aiStripText.textContent = thought;
    el.aiStripPct.textContent = `${Math.round(top.p * 100)}%`;
    el.aiStripPct.className = `num text-sm ${top.label === target ? "text-emerald-400" : "text-zinc-500"}`;
    setStatus("thinking", "thinking");
    el.guesses.innerHTML = preds.slice(0, 3).map((p, i) => {
      const pct = Math.round(p.p * 100);
      const hit = p.label === target;
      const bar = hit ? "bg-emerald-400" : i === 0 ? "bg-zinc-100" : "bg-zinc-600";
      return `<li>
        <div class="flex items-center justify-between text-[13px] mb-1.5">
          <span class="flex items-center gap-1.5 ${hit ? "text-emerald-400 font-medium" : i === 0 ? "text-zinc-100" : "text-zinc-400"}">${label(p.label)}${hit ? '<i class="ph-fill ph-check-circle"></i>' : ""}</span>
          <span class="num text-zinc-500">${pct}%</span>
        </div>
        <div class="h-1 rounded-full bg-white/[.06] overflow-hidden"><div class="bar h-full rounded-full ${bar}" style="width:${pct}%"></div></div>
      </li>`;
    }).join("");
  }

  // ---------- Game flow ----------
  // mode: "solo" (all-time board), "daily" (today's prompts, daily board) or "room".
  let mode = "solo";
  let countdownTimer = 0;

  function paintPips() {
    $("pips").innerHTML = Array.from({ length: ROUNDS }, (_, i) => {
      const r = state.results[i];
      const cls = r ? (r.matched ? "w-2 bg-emerald-400" : "w-2 bg-red-400/70")
        : i === state.round ? "w-5 bg-zinc-100" : "w-2 bg-zinc-700/80";
      return `<span class="h-2 rounded-full transition-all duration-300 ${cls}"></span>`;
    }).join("");
  }

  function stopGame() {
    if (state) { state.active = false; state.drawing = false; cancelAnimationFrame(state.raf); }
    clearInterval(countdownTimer);
    el.overlay.classList.add("hidden");
    $("countdown").classList.add("hidden");
  }

  function startGame(opts = {}) {
    Sfx.unlock();
    mode = opts.mode || "solo";
    playLevel = opts.level || level;
    stopGame();
    state = newState(opts.prompts || pickPrompts());
    const where = mode === "daily" ? "Daily challenge" : mode === "room" ? `Room ${room.code}` : "Solo";
    $("thresholdLabel").textContent = Math.round(playLevel.threshold * 100);
    $("hudLevel").textContent = `${where} · ${playLevel.name}`;
    $("summaryLevel").textContent = `Final score · ${where} · ${playLevel.name}`;
    $("roomPanel").classList.toggle("hidden", mode !== "room");
    $("roomChip").classList.toggle("hidden", mode !== "room");
    el.score.textContent = "0";
    go("game");
    resizeBoard();
    paintPips();
    if (!opts.at || opts.at <= Date.now()) { startRound(); return; }
    // Rooms: everyone starts at the same moment, after a short countdown.
    el.prompt.textContent = "Get ready";
    el.timeLeft.textContent = playLevel.time.toFixed(1);
    el.timerBar.style.width = "100%";
    el.roundNum.textContent = 1;
    $("countdownFirst").textContent = `${playLevel.name} · ${playLevel.time} seconds per drawing`;
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

  function setUrgent(on) {
    el.timeLeft.classList.toggle("text-red-400", on);
    el.timerBar.classList.toggle("bg-red-400", on);
    el.timerBar.classList.toggle("bg-zinc-100", !on);
  }

  function startRound() {
    Object.assign(state, { strokes: [], drawing: false, active: true, best: null, lastTop: null, lastTickSec: null, lastPredict: 0, matchSince: null });
    const target = state.prompts[state.round];
    el.roundNum.textContent = state.round + 1;
    el.prompt.textContent = label(target);
    el.timeLeft.textContent = playLevel.time.toFixed(1);
    setUrgent(false);
    el.timerBar.style.width = "100%";
    el.prompt.classList.remove("pop"); void el.prompt.offsetWidth; el.prompt.classList.add("pop");
    el.overlay.classList.add("hidden");
    el.aiEye.getContext("2d").clearRect(0, 0, 28, 28);
    paintPips();
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
    setUrgent(left <= 5);
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
    el.score.textContent = fmt(state.score);
    paintPips();

    if (matched) {
      Sfx.match();
      setStatus("match", "match");
      el.overlayIcon.className = "grid place-items-center w-10 h-10 rounded-full shrink-0 bg-emerald-400/10 text-emerald-400 border border-emerald-400/20";
      el.overlayIcon.innerHTML = '<i class="ph ph-check text-[20px]"></i>';
      el.overlayTitle.textContent = "Match";
      el.overlaySub.innerHTML = `<span class="num">${Math.round(confidence * 100)}%</span> sure in <span class="num">${elapsed.toFixed(1)}s</span> · ${BASE_POINTS} + <span class="num">${bonus}</span> speed bonus`;
      el.overlayPoints.className = "num text-lg font-semibold text-emerald-400";
      el.overlayPoints.textContent = `+${fmt(points)}`;
    } else {
      Sfx.fail();
      setStatus(skipped ? "skipped" : "time up", "miss");
      el.overlayIcon.className = "grid place-items-center w-10 h-10 rounded-full shrink-0 bg-white/[.04] text-zinc-400 border border-white/[.08]";
      el.overlayIcon.innerHTML = `<i class="ph ${skipped ? "ph-skip-forward" : "ph-timer"} text-[20px]"></i>`;
      el.overlayTitle.textContent = skipped ? "Skipped" : "Time's up";
      el.overlaySub.textContent = state.best ? `The AI thought it looked like ${withArticle(state.best.top.label)}.` : "The AI didn't see anything to guess.";
      el.overlayPoints.className = "num text-lg font-semibold text-zinc-600";
      el.overlayPoints.textContent = "+0";
      el.boardWrap.classList.add("shake");
      setTimeout(() => el.boardWrap.classList.remove("shake"), 700);
    }
    setText(el.nextBtn, state.round + 1 >= ROUNDS ? "See results" : "Next round");
    el.overlay.classList.remove("hidden");
    if (mode === "room") sendRoomProgress(state.round + 1 >= ROUNDS);
  }

  function snapshot() {
    const c = document.createElement("canvas");
    c.width = c.height = 200;
    const x = c.getContext("2d");
    x.fillStyle = THUMB_BG; x.fillRect(0, 0, 200, 200);
    // Re-draw the vector strokes, fitted to the thumbnail.
    const pts = state.strokes.flat();
    if (!pts.length) return c.toDataURL();
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const s = 156 / Math.max(maxX - minX, maxY - minY, 1);
    const ox = (200 - (maxX - minX) * s) / 2 - minX * s, oy = (200 - (maxY - minY) * s) / 2 - minY * s;
    x.strokeStyle = "#e4e4e7"; x.lineWidth = 3.5; x.lineCap = "round"; x.lineJoin = "round";
    for (const st of state.strokes) {
      x.beginPath();
      st.forEach((p, i) => (i ? x.lineTo(p.x * s + ox, p.y * s + oy) : x.moveTo(p.x * s + ox, p.y * s + oy)));
      if (st.length === 1) x.lineTo(st[0].x * s + ox + 0.1, st[0].y * s + oy);
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
    go("results");
    const r = state.results;
    const matched = r.filter((x) => x.matched);
    const rank = RANKS.find((k) => state.score >= k.min);
    el.finalScore.textContent = fmt(state.score);
    el.finalScore.classList.remove("pop"); void el.finalScore.offsetWidth; el.finalScore.classList.add("pop");
    el.finalRank.textContent = rank.name;
    el.rankHint.textContent = rank.hint;
    el.statMatched.textContent = `${matched.length}/${ROUNDS}`;
    el.statAvg.textContent = matched.length ? `${(matched.reduce((a, b) => a + b.time, 0) / matched.length).toFixed(1)}s` : "–";
    el.statBest.textContent = matched.length ? `${Math.min(...matched.map((x) => x.time)).toFixed(1)}s` : "–";
    el.roundCards.innerHTML = r.map((x, i) => `
      <div class="card p-1.5 enter w-[136px] shrink-0 snap-start sm:w-auto" style="animation-delay:${i * 50}ms">
        <div class="relative">
          <img src="${x.image}" alt="Your ${esc(x.target)} sketch" class="w-full aspect-square rounded-lg border border-white/[.05]" />
          <span class="absolute top-1.5 right-1.5 grid place-items-center w-5 h-5 rounded-full ${x.matched ? "bg-emerald-400 text-zinc-950" : "bg-zinc-800 text-zinc-400"}">
            <i class="${x.matched ? "ph-fill ph-check" : x.skipped ? "ph ph-skip-forward" : "ph ph-x"} text-[11px]"></i>
          </span>
        </div>
        <div class="px-1.5 pt-2.5 pb-1.5">
          <div class="flex items-baseline justify-between gap-2">
            <div class="text-[13px] font-medium truncate">${label(x.target)}</div>
            <div class="num text-[13px] ${x.points ? "text-zinc-100" : "text-zinc-600"}">+${fmt(x.points)}</div>
          </div>
          <div class="text-[11px] mt-0.5 truncate ${x.matched ? "text-emerald-400" : "text-zinc-500"}">
            ${x.matched ? `<span class="num">${x.time.toFixed(1)}s · ${Math.round(x.confidence * 100)}%</span>` : x.skipped ? "Skipped" : x.aiGuess ? `AI saw ${esc(x.aiGuess)}` : "Not recognized"}
          </div>
        </div>
      </div>`).join("");
    if (rank.min > 6000) Sfx.fanfare(); else Sfx.match();
    showOnlineResult();
  }

  // ---------- Leaving a game ----------
  $("exitBtn").addEventListener("click", () => {
    const pop = $("exitPop");
    if (!pop.classList.contains("hidden")) return pop.classList.add("hidden");
    $("exitText").textContent =
      mode === "daily" ? `This counts as today's game. Your score so far (${fmt(state.score)}) will be saved.` :
      mode === "room" ? `You'll leave room ${room ? room.code : ""}.` :
      "This game won't be saved.";
    pop.classList.remove("hidden");
  });
  $("exitStay").addEventListener("click", () => $("exitPop").classList.add("hidden"));
  $("exitLeave").addEventListener("click", () => {
    stopGame();
    if (mode === "room") return leaveRoom();
    if (mode === "daily") { lockDaily(state.score); return go("daily"); }
    go("play");
  });

  // ---------- Online helpers ----------
  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  function rankCell(rank) {
    if (rank === 1) return '<i class="ph-fill ph-crown-simple text-[16px] text-zinc-100"></i>';
    if (rank === 2) return '<i class="ph-fill ph-medal text-[16px] text-zinc-300"></i>';
    if (rank === 3) return '<i class="ph-fill ph-medal text-[16px] text-zinc-500"></i>';
    return `<span class="num text-[13px] text-zinc-500">${rank}</span>`;
  }
  // One row of a ranking list. `sub` is trusted HTML built here, `name` is escaped.
  // plain: show the position as a number (lobby order is not a ranking).
  const row = (rank, name, right, { me = false, sub = "", plain = false } = {}) => `
    <li class="flex items-center gap-3 px-4 h-[52px] ${me ? "bg-emerald-400/[.05]" : ""}">
      <span class="w-6 shrink-0 grid place-items-center">${plain ? `<span class="num text-[13px] text-zinc-500">${rank}</span>` : rankCell(rank)}</span>
      <span class="avatar ${me ? "!bg-emerald-400/15 !text-emerald-300 !border-emerald-400/20" : ""}">${initial(name)}</span>
      <span class="flex-1 min-w-0 flex items-center gap-2">
        <span class="truncate text-sm ${me ? "font-medium" : "text-zinc-200"}">${esc(name)}</span>
        ${me ? '<span class="shrink-0 text-[11px] font-medium text-emerald-400">you</span>' : ""}
        ${sub ? `<span class="shrink-0 flex items-center gap-1 text-[12px] text-zinc-500">${sub}</span>` : ""}
      </span>
      <span class="num text-sm">${right === "" ? "" : fmt(right)}</span>
    </li>`;
  const emptyRow = (text, icon = "ph-trophy") => `<li class="flex flex-col items-center px-4 py-10 text-center text-[13px] text-zinc-500">
      <i class="ph ${icon} text-[22px] text-zinc-600 mb-2"></i>${text}</li>`;
  const loadingRow = () => `<li class="flex items-center justify-center gap-2 px-4 py-10 text-[13px] text-zinc-500">
      <i class="ph ph-circle-notch animate-spin text-[16px]"></i>Loading…</li>`;

  async function fetchBoard(board, lv) {
    return api(`/api/scores?board=${board}&level=${lv}&player=${encodeURIComponent(playerId)}`);
  }
  function boardRows(data, limit = Infinity) {
    if (!data.entries.length) return emptyRow(data.board === "daily" ? "No one has played today's challenge yet." : "No scores yet. Be the first!");
    const shown = data.entries.slice(0, limit);
    let html = shown.map((e) => row(e.rank, e.name, e.score, { me: e.id === playerId })).join("");
    if (data.me && data.me.rank > shown.length) html += row(data.me.rank, playerName() || "You", data.me.score, { me: true });
    return html;
  }

  // ---------- Daily challenge ----------
  const dailyKey = (lv) => `sketchx.daily.${today()}.${lv}`;
  const dailyPlayed = () => localStorage.getItem(dailyKey(levelKey(level)));
  function lockDaily(score) {
    const lv = levelKey(playLevel);
    if (localStorage.getItem(dailyKey(lv)) !== null) return;
    localStorage.setItem(dailyKey(lv), score);
    if (playerName()) api("/api/scores", { board: "daily", level: lv, player: playerId, name: playerName(), score }).catch(() => {});
    updateDaily();
  }
  function updateDaily() {
    const played = dailyPlayed();
    $("playDailyStatus").innerHTML = played === null
      ? `${level.name} · not played yet today`
      : `<span class="text-emerald-400">Played</span> · you scored <span class="num text-zinc-300">${fmt(played)}</span> on ${level.name}`;
    $("dailyTodo").classList.toggle("hidden", played !== null);
    $("dailyDone").classList.toggle("hidden", played === null);
    if (played !== null) $("dailyScore").textContent = fmt(played);
    $("dailyTopLevel").textContent = level.name;
    if (current === "daily") loadDailyTop();
  }
  function updateReset() {
    const now = new Date();
    const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now;
    const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
    $("dailyReset").textContent = `New challenge in ${h}h ${m}m`;
  }
  setInterval(updateReset, 30000);
  let dailyReq = 0;
  async function loadDailyTop() {
    const req = ++dailyReq, lv = levelKey(level);
    $("dailyTop").innerHTML = loadingRow();
    try {
      const data = await fetchBoard("daily", lv);
      if (req === dailyReq) $("dailyTop").innerHTML = boardRows(data, 5);
    } catch (e) {
      if (req === dailyReq) $("dailyTop").innerHTML = emptyRow(`Couldn't load the leaderboard: ${esc(e.message)}`, "ph-cloud-slash");
    }
  }
  function renderDaily() {
    $("dailyDate").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }) + " · UTC";
    updateReset();
    paintGate("daily");
    updateDaily();
  }
  $("dailyBtn").addEventListener("click", () => {
    if (dailyPlayed() !== null) return openBoard("daily", levelKey(level));
    if (!requireName("daily")) return;
    if (room) leaveRoom(null, { silent: true });
    startGame({ mode: "daily", prompts: pickPrompts(daySeed(today())) });
  });

  // ---------- Leaderboard ----------
  let boardView = { board: "daily", level: "normal" };
  function paintToggles() {
    for (const b of $$("[data-board]")) b.setAttribute("aria-pressed", b.dataset.board === boardView.board);
    for (const b of $$("[data-board-level]")) b.setAttribute("aria-pressed", b.dataset.boardLevel === boardView.level);
  }
  async function renderBoard() {
    paintToggles();
    const { board, level: lv } = boardView;
    $("boardList").innerHTML = loadingRow();
    $("boardNote").innerHTML = `<i class="ph ph-info text-[14px]"></i>${board === "daily"
      ? "Same 5 prompts for everyone today (UTC). Only your first game counts."
      : "Your best solo game counts."}`;
    try {
      const data = await fetchBoard(board, lv);
      if (boardView.board !== board || boardView.level !== lv) return; // a newer tab was picked meanwhile
      $("boardList").innerHTML = boardRows(data);
    } catch (e) {
      $("boardList").innerHTML = emptyRow(`Couldn't load the leaderboard: ${esc(e.message)}`, "ph-cloud-slash");
    }
  }
  function openBoard(board = "daily", lv = levelKey(level)) {
    boardView = { board, level: lv };
    go("board");
    renderBoard();
  }
  for (const b of $$("[data-board]")) b.addEventListener("click", () => { boardView.board = b.dataset.board; renderBoard(); });
  for (const b of $$("[data-board-level]")) b.addEventListener("click", () => { boardView.level = b.dataset.boardLevel; renderBoard(); });

  // ---------- Rooms ----------
  // room: { code, data (last server state), offset (server clock - local clock), playedGame, poll }
  let room = null;
  const POLL_MS = 1500;
  const isHost = () => room && room.data && room.data.host === playerId;
  const paintRoomDot = () => { for (const d of $$(".room-dot")) d.classList.toggle("hidden", !room); };

  function renderFriends(hint) {
    $("roomJoin").classList.toggle("hidden", !!room);
    $("roomLobby").classList.toggle("hidden", !room);
    if (room) { $("lobbyError").textContent = ""; renderRoom(); }
    else paintGate("friends", hint);
  }

  async function enterRoom(action, extra) {
    $("roomError").textContent = "";
    try {
      const t0 = Date.now();
      const data = await api("/api/rooms", { action, player: playerId, name: playerName(), ...extra });
      room = { code: data.code, data, offset: data.serverNow - (t0 + Date.now()) / 2, playedGame: data.game, poll: 0 };
      history.replaceState(null, "", `?room=${data.code}`);
      room.poll = setInterval(pollRoom, POLL_MS);
      paintRoomDot();
      go("friends");
    } catch (e) {
      $("roomError").innerHTML = `<i class="ph ph-warning-circle text-[15px]"></i>${esc(e.message)}`;
    }
  }
  $("createRoomBtn").addEventListener("click", () => { if (requireName("friends")) enterRoom("create", { level: levelKey(level) }); });
  $("joinRoomBtn").addEventListener("click", () => {
    if (!requireName("friends")) return;
    const code = $("codeInput").value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { $("roomError").innerHTML = '<i class="ph ph-warning-circle text-[15px]"></i>Room codes are 4 letters.'; return; }
    enterRoom("join", { code });
  });
  $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinRoomBtn").click(); });

  // silent: leave without changing the view (used when starting a solo or daily game).
  function leaveRoom(message, { silent = false } = {}) {
    if (!room) return;
    clearInterval(room.poll);
    api("/api/rooms", { action: "leave", code: room.code, player: playerId }).catch(() => {});
    room = null;
    paintRoomDot();
    history.replaceState(null, "", location.pathname);
    if (silent) return;
    if (mode === "room") stopGame();
    go("friends");
    if (message) $("roomError").innerHTML = `<i class="ph ph-warning-circle text-[15px]"></i>${esc(message)}`;
  }
  $("leaveRoomBtn").addEventListener("click", () => leaveRoom());

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
      // The host started a game: everyone begins at the same server time, from whichever view they're on.
      room.playedGame = data.game;
      startGame({ mode: "room", level: LEVELS[data.level], prompts: pickPrompts(data.seed), at: data.startAt - room.offset });
    }
    renderRoom();
  }

  function roomSub(p) {
    const d = room.data;
    if (d.status !== "playing" && !p.round) return p.isHost ? '<i class="ph-fill ph-crown-simple"></i>host' : "";
    return p.done ? '<i class="ph-fill ph-check-circle text-emerald-400"></i>finished' : p.round ? `round <span class="num">${p.round}/${d.rounds}</span>` : "drawing";
  }
  function roomRows(compact) {
    const d = room.data;
    return d.players.map((p, i) => {
      const me = p.id === playerId;
      const scored = d.status === "playing" || p.round;
      if (!compact) return row(i + 1, p.name, scored ? p.score : "", { me, sub: roomSub(p), plain: !scored });
      return `<li class="flex items-center gap-2.5 h-10 px-2 rounded-lg ${me ? "bg-white/[.04]" : ""}">
        <span class="w-4 num text-[12px] text-zinc-500">${i + 1}</span>
        <span class="avatar !w-6 !h-6 !text-[10px] ${me ? "!bg-emerald-400/15 !text-emerald-300" : ""}">${initial(p.name)}</span>
        <span class="flex-1 min-w-0 truncate text-[13px] ${me ? "font-medium" : "text-zinc-300"}">${esc(p.name)}</span>
        <span class="text-[11px] text-zinc-500">${p.done ? '<i class="ph-fill ph-check-circle text-emerald-400 text-[14px]"></i>' : `<span class="num">${p.round}/${d.rounds}</span>`}</span>
        <span class="w-12 text-right num text-[13px]">${fmt(p.score)}</span>
      </li>`;
    }).join("");
  }

  function renderRoom() {
    if (!room || !room.data) return;
    const d = room.data, host = isHost();
    // Lobby
    $("lobbyCode").textContent = d.code;
    const lv = LEVELS[d.level];
    $("lobbyLevel").textContent = `${lv.name} · ${lv.time} seconds per drawing · AI must be ${Math.round(lv.threshold * 100)}% sure`;
    $("lobbyCount").textContent = `${d.players.length} of 12`;
    $("lobbyPlayers").innerHTML = roomRows(false);
    const running = d.status === "playing" && d.players.some((p) => !p.done);
    $("startRoomBtn").classList.toggle("hidden", !host);
    setText($("startRoomBtn"), d.game ? "Start next game" : "Start game");
    $("lobbyWait").classList.toggle("hidden", host);
    $("lobbyWait").lastElementChild.textContent = running ? "A game is in progress…" : "Waiting for the host to start…";
    // In-game panel, mobile chip and sheet
    $("roomPanelCode").textContent = d.code;
    $("roomSheetCode").textContent = d.code;
    const compact = roomRows(true);
    $("roomPanelList").innerHTML = compact;
    $("roomSheetList").innerHTML = compact;
    const me = d.players.findIndex((p) => p.id === playerId);
    $("roomChip").innerHTML = `<span class="flex items-center gap-1.5"><i class="ph ph-users-three text-[14px]"></i>#${me + 1}<span class="text-zinc-500">/${d.players.length}</span></span>`;
    // Results
    if (mode === "room" && current === "results") renderRoomSummary();
  }
  $("roomChip").addEventListener("click", () => $("roomSheet").classList.remove("hidden"));
  $("roomSheetBackdrop").addEventListener("click", () => $("roomSheet").classList.add("hidden"));

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
    const btn = $("copyLinkBtn"), icon = btn.querySelector("i");
    const link = `${location.origin}${location.pathname}?room=${room.code}`;
    try { await navigator.clipboard.writeText(link); setText(btn, "Copied"); icon.className = "ph ph-check text-emerald-400"; }
    catch { setText(btn, link); }
    setTimeout(() => { setText(btn, "Copy invite link"); icon.className = "ph ph-link-simple"; }, 2000);
  });

  // ---------- Results ----------
  function setOnline(title, note, html) {
    $("summaryOnline").classList.remove("hidden");
    $("summaryOnlineTitle").textContent = title;
    $("summaryOnlineNote").innerHTML = note;
    $("summaryOnlineList").innerHTML = html;
    $("summaryOnlineList").classList.toggle("hidden", !html);
  }

  function renderRoomSummary() {
    const d = room.data, waiting = d.players.filter((p) => !p.done).length;
    setOnline(`Room ${d.code}`, waiting ? `${waiting} still drawing…` : "Everyone finished", roomRows(false));
    const host = isHost();
    el.againBtn.classList.toggle("hidden", !host);
    setText(el.againBtn, "Start next game");
    $("summaryWait").classList.toggle("hidden", host);
  }

  async function showOnlineResult() {
    $("summaryOnline").classList.add("hidden");
    $("summaryWait").classList.add("hidden");
    el.againBtn.classList.remove("hidden");
    setText(el.homeBtn, "Home");
    if (mode === "room") {
      if (!room) return;
      setText(el.homeBtn, "Leave room");
      return renderRoomSummary();
    }
    const board = mode === "daily" ? "daily" : "all";
    const lv = levelKey(playLevel);
    setText(el.againBtn, mode === "daily" ? "Play solo" : "Play again");
    if (mode === "daily") { localStorage.setItem(dailyKey(lv), state.score); updateDaily(); }
    const title = `${board === "daily" ? "Today's challenge" : "All time"} · ${playLevel.name}`;
    if (!playerName()) {
      setOnline(title, "", emptyRow('<button class="name-cta text-zinc-200 underline underline-offset-4 decoration-zinc-600 hover:decoration-zinc-300">Add your name</button> to join the leaderboard.', "ph-user"));
      return;
    }
    setOnline(title, "Saving…", loadingRow());
    try {
      const res = await api("/api/scores", { board, level: lv, player: playerId, name: playerName(), score: state.score });
      const data = await fetchBoard(board, lv);
      const note = board === "daily" && !res.counted
        ? `Only your first game today counts · you're #${res.rank}`
        : `You're #${res.rank}${board === "all" && res.score > state.score ? ` with your best of ${fmt(res.score)}` : ""}`;
      setOnline(title, esc(note), boardRows(data));
    } catch (e) {
      setOnline(title, "", emptyRow(`Couldn't save your score: ${esc(e.message)}`, "ph-cloud-slash"));
    }
  }

  el.againBtn.addEventListener("click", () => {
    if (mode === "room") return hostStart();
    startGame({ mode: "solo" });
  });
  el.homeBtn.addEventListener("click", () => (mode === "room" && room ? leaveRoom() : go("play")));

  // ---------- Buttons & keys ----------
  el.startBtn.addEventListener("click", () => {
    if (room) leaveRoom(null, { silent: true });
    startGame({ mode: "solo" });
  });
  el.nextBtn.addEventListener("click", next);
  const undo = () => { if (!state || !state.active) return; state.strokes.pop(); redraw(); predict(true); };
  el.undoBtn.addEventListener("click", undo);
  el.clearBtn.addEventListener("click", () => { if (!state || !state.active) return; state.strokes = []; redraw(); renderGuesses(null); });
  el.skipBtn.addEventListener("click", () => state && state.active && endRound(false, 0, true));

  const ICON_SOUND = "ph ph-speaker-high", ICON_MUTED = "ph ph-speaker-slash";
  for (const b of $$(".mute-btn")) {
    b.addEventListener("click", () => {
      const muted = Sfx.toggle();
      for (const m of $$(".mute-btn")) m.querySelector("i").className = muted ? ICON_MUTED : ICON_SOUND;
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return closePopovers();
    if (current !== "game") return;
    if (e.key === "Enter" && !el.overlay.classList.contains("hidden") && $("exitPop").classList.contains("hidden")) { e.preventDefault(); next(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  });

  // ---------- Start ----------
  paintName();
  setLevel(levelKey(level));
  go("play");
  // Invite links: ?room=ABCD opens Friends with the code filled in.
  const invited = new URLSearchParams(location.search).get("room");
  if (invited && /^[A-Za-z]{4}$/.test(invited) && cnn) {
    const code = invited.toUpperCase();
    $("codeInput").value = code;
    go("friends");
    if (playerName()) enterRoom("join", { code });
    else renderFriends(`Enter a name to join room ${code}`);
  }
})();
