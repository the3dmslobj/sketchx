// Sketch Duel: game loop, drawing, live AI predictions, scoring.
(function () {
  const ROUNDS = 5;
  const ROUND_TIME = 20; // seconds
  const THRESHOLD = 0.7; // AI confidence needed to declare a match
  const BASE_POINTS = 500;
  const POINTS_PER_SECOND = 50; // bonus for every second left on the clock
  const PREDICT_EVERY_MS = 200;

  const RANKS = [
    { min: 6001, name: "AI WHISPERER", hint: "The network understands you perfectly. Top rank unlocked!" },
    { min: 3500, name: "PIXEL PRO", hint: "Score over 6000 to become an AI Whisperer." },
    { min: 1500, name: "SKETCH CADET", hint: "Draw faster and simpler. Score over 6000 for the top rank." },
    { min: 0, name: "DOODLE ROOKIE", hint: "Tip: draw the most iconic shape first. The AI learned from millions of quick doodles." },
  ];

  const EMOJI = {
    cat: "🐱", fish: "🐟", house: "🏠", tree: "🌳", sun: "☀️", star: "⭐", car: "🚗", bicycle: "🚲",
    apple: "🍎", banana: "🍌", umbrella: "☂️", clock: "🕒", cup: "☕", flower: "🌸", bird: "🐦",
    guitar: "🎸", airplane: "✈️", pizza: "🍕", snowman: "⛄", rainbow: "🌈", butterfly: "🦋",
    eyeglasses: "👓", moon: "🌙", key: "🔑",
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("startScreen"), game: $("gameScreen"), summary: $("summaryScreen"),
    startBtn: $("startBtn"), modelInfo: $("modelInfo"), hudRound: $("hudRound"), hudScore: $("hudScore"),
    roundNum: $("roundNum"), score: $("score"), prompt: $("prompt"), timeLeft: $("timeLeft"), timerBar: $("timerBar"),
    board: $("board"), overlay: $("overlay"), overlayTitle: $("overlayTitle"), overlaySub: $("overlaySub"),
    nextBtn: $("nextBtn"), clearBtn: $("clearBtn"), undoBtn: $("undoBtn"), skipBtn: $("skipBtn"),
    guesses: $("guesses"), aiThought: $("aiThought"), aiDot: $("aiDot"), aiStatusText: $("aiStatusText"),
    aiEye: $("aiEye"), muteBtn: $("muteBtn"), finalScore: $("finalScore"), finalRank: $("finalRank"),
    rankHint: $("rankHint"), roundCards: $("roundCards"), againBtn: $("againBtn"),
    statMatched: $("statMatched"), statAvg: $("statAvg"), statBest: $("statBest"),
  };
  $("thresholdLabel").textContent = Math.round(THRESHOLD * 100);

  // ---------- Model ----------
  let cnn = null;
  try {
    cnn = new SketchCNN(window.SKETCH_MODEL);
    el.startBtn.disabled = false;
    el.startBtn.textContent = "START DUEL";
    el.modelInfo.textContent = `AI knows ${cnn.classes.length} objects · validation accuracy ${(window.SKETCH_MODEL.valAccuracy * 100).toFixed(1)}%`;
  } catch (e) {
    el.startBtn.textContent = "MODEL MISSING";
    el.modelInfo.textContent = "Could not load model.js. Run training/train.py first.";
    console.error(e);
  }

  // ---------- State ----------
  let state = null;
  const newState = () => ({
    prompts: shuffle([...cnn.classes]).slice(0, ROUNDS),
    round: 0, score: 0, results: [],
    strokes: [], drawing: false, active: false,
    startTime: 0, raf: 0, lastPredict: 0, lastTickSec: null, best: null, lastTop: null,
  });

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const label = (c) => c.toUpperCase();
  const show = (screen) => {
    for (const s of [el.start, el.game, el.summary]) s.classList.toggle("hidden", s !== screen);
    const inGame = screen === el.game;
    el.hudRound.classList.toggle("hidden", !inGame);
    el.hudScore.classList.toggle("hidden", screen === el.start);
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
    g.strokeStyle = "#1b1030"; g.lineWidth = Math.max(4, r.width / 120); g.lineCap = "round"; g.lineJoin = "round";
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
    if (inkLength() < 30) { renderGuesses(null); return; }
    const px = rasterizeStrokes(state.strokes);
    if (!px) return;
    drawEye(px);
    const preds = cnn.predict(px);
    renderGuesses(preds);
    const target = state.prompts[state.round];
    const pTarget = preds.find((p) => p.label === target).p;
    if (!state.best || pTarget > state.best.pTarget) state.best = { pTarget, top: preds[0] };
    if (preds[0].label !== state.lastTop) { state.lastTop = preds[0].label; Sfx.guess(); }
    if (preds[0].label === target && preds[0].p >= THRESHOLD) endRound(true, preds[0].p);
  }

  function drawEye(px) {
    const c = el.aiEye.getContext("2d");
    const img = c.createImageData(28, 28);
    for (let i = 0; i < 784; i++) {
      const v = Math.round(px[i] * 255);
      img.data[i * 4] = v * 0.18; img.data[i * 4 + 1] = v * 0.89; img.data[i * 4 + 2] = v * 0.9; img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }

  function renderGuesses(preds) {
    const target = state.prompts[state.round];
    if (!preds) {
      el.guesses.innerHTML = "";
      el.aiThought.textContent = "Start drawing…";
      setStatus("waiting", "bg-slate-500");
      return;
    }
    const top = preds[0];
    const name = top.label;
    el.aiThought.textContent =
      top.p >= THRESHOLD ? `Oh I know, it's a ${name}!` :
      top.p >= 0.4 ? `I think it's a ${name}…` :
      top.p >= 0.2 ? `Is it a ${name}?` : "Hmm… not sure yet";
    setStatus("thinking", "bg-neon-cyan animate-pulse");
    el.guesses.innerHTML = preds.slice(0, 3).map((p, i) => {
      const pct = Math.round(p.p * 100);
      const hit = p.label === target;
      const bar = hit ? "bg-neon-lime" : i === 0 ? "bg-neon-cyan" : "bg-white/30";
      return `<li>
        <div class="flex justify-between text-sm mb-1">
          <span class="${hit ? "text-neon-lime font-semibold" : ""}">${EMOJI[p.label] || ""} ${p.label}${hit ? " ✓" : ""}</span>
          <span class="tabular-nums text-slate-300">${pct}%</span>
        </div>
        <div class="h-2 rounded-full bg-white/10 overflow-hidden"><div class="bar h-full ${bar}" style="width:${pct}%"></div></div>
      </li>`;
    }).join("");
  }
  function setStatus(text, dot) { el.aiStatusText.textContent = text; el.aiDot.className = `w-2 h-2 rounded-full ${dot}`; }

  // ---------- Game flow ----------
  function startGame() {
    Sfx.unlock();
    state = newState();
    el.score.textContent = "0";
    show(el.game);
    resizeBoard();
    startRound();
  }

  function startRound() {
    Object.assign(state, { strokes: [], drawing: false, active: true, best: null, lastTop: null, lastTickSec: null, lastPredict: 0 });
    const target = state.prompts[state.round];
    el.roundNum.textContent = state.round + 1;
    el.prompt.textContent = `${EMOJI[target] || ""} ${label(target)}`;
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
    const left = Math.max(0, ROUND_TIME - elapsed);
    el.timeLeft.textContent = left.toFixed(1);
    el.timeLeft.classList.toggle("text-neon-pink", left <= 5);
    el.timerBar.style.width = `${(left / ROUND_TIME) * 100}%`;
    const sec = Math.ceil(left);
    if (sec !== state.lastTickSec && sec <= 5 && sec > 0) { sec <= 3 ? Sfx.urgent() : Sfx.tick(); }
    state.lastTickSec = sec;
    if (state.drawing) predict(false);
    if (left <= 0) return endRound(false);
    state.raf = requestAnimationFrame(tick);
  }

  function endRound(matched, confidence = 0, skipped = false) {
    if (!state.active) return;
    state.active = false;
    state.drawing = false;
    cancelAnimationFrame(state.raf);
    const elapsed = Math.min(ROUND_TIME, (performance.now() - state.startTime) / 1000);
    const left = ROUND_TIME - elapsed;
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
      setStatus("match!", "bg-neon-lime");
      el.overlayTitle.className = "font-arcade text-2xl sm:text-4xl mb-3 text-neon-lime";
      el.overlayTitle.textContent = "MATCH!";
      el.overlaySub.innerHTML = `AI was <b>${Math.round(confidence * 100)}%</b> sure in <b>${elapsed.toFixed(1)}s</b><br>
        <span class="font-arcade text-xs text-neon-amber">+${BASE_POINTS} base +${bonus} speed bonus</span>`;
    } else {
      Sfx.fail();
      setStatus(skipped ? "skipped" : "time up", "bg-neon-pink");
      el.overlayTitle.className = "font-arcade text-2xl sm:text-4xl mb-3 text-neon-pink";
      el.overlayTitle.textContent = skipped ? "SKIPPED" : "TIME'S UP!";
      el.overlaySub.textContent = state.best ? `The AI thought it looked like a ${state.best.top.label}.` : "The AI didn't see anything to guess.";
      el.board.parentElement.classList.add("shake");
      setTimeout(() => el.board.parentElement.classList.remove("shake"), 700);
    }
    el.nextBtn.textContent = state.round + 1 >= ROUNDS ? "SEE RESULTS ▶" : "NEXT ROUND ▶";
    el.overlay.classList.remove("hidden");
  }

  function snapshot() {
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    const x = c.getContext("2d");
    x.fillStyle = "#f6f3ff"; x.fillRect(0, 0, 160, 160);
    // Re-draw the vector strokes, fitted to the thumbnail.
    const pts = state.strokes.flat();
    if (!pts.length) return c.toDataURL();
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const s = 130 / Math.max(maxX - minX, maxY - minY, 1);
    const ox = (160 - (maxX - minX) * s) / 2 - minX * s, oy = (160 - (maxY - minY) * s) / 2 - minY * s;
    x.strokeStyle = "#1b1030"; x.lineWidth = 3; x.lineCap = "round"; x.lineJoin = "round";
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
      <div class="panel rounded-xl p-3 text-center">
        <div class="text-[10px] font-arcade text-slate-400 mb-2">ROUND ${i + 1}</div>
        <img src="${x.image}" alt="Your ${x.target} sketch" class="w-full rounded-lg mb-2" />
        <div class="font-semibold">${EMOJI[x.target] || ""} ${x.target}</div>
        <div class="text-xs mt-1 ${x.matched ? "text-neon-lime" : "text-neon-pink"}">
          ${x.matched ? `✓ ${x.time.toFixed(1)}s · ${Math.round(x.confidence * 100)}%` : x.skipped ? "✗ skipped" : "✗ not recognized"}
        </div>
        ${!x.matched && x.aiGuess ? `<div class="text-[11px] text-slate-500">AI saw: ${x.aiGuess}</div>` : ""}
        <div class="font-arcade text-xs text-neon-amber mt-2">+${x.points}</div>
      </div>`).join("");
    if (rank.min > 6000) Sfx.fanfare(); else Sfx.match();
  }

  // ---------- Buttons ----------
  el.startBtn.addEventListener("click", startGame);
  el.againBtn.addEventListener("click", startGame);
  el.nextBtn.addEventListener("click", next);
  el.clearBtn.addEventListener("click", () => { if (!state.active) return; state.strokes = []; redraw(); renderGuesses(null); });
  el.undoBtn.addEventListener("click", () => { if (!state.active) return; state.strokes.pop(); redraw(); predict(true); });
  el.skipBtn.addEventListener("click", () => state && state.active && endRound(false, 0, true));
  el.muteBtn.addEventListener("click", () => { el.muteBtn.textContent = Sfx.toggle() ? "🔇" : "🔊"; });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !el.overlay.classList.contains("hidden") && !el.game.classList.contains("hidden")) next();
  });
})();
