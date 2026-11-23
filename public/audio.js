// Arcade sound effects synthesized with the Web Audio API: no audio files.
(function () {
  let ctx = null;
  let muted = false;

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // One oscillator note with an attack/decay envelope, optional pitch slide.
  function tone(freq, dur, { type = "square", vol = 0.12, at = 0, slideTo = null } = {}) {
    if (muted) return;
    const c = ac();
    const t = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const arp = (notes, step, opts) => notes.forEach((f, i) => tone(f, step * 1.6, { ...opts, at: i * step }));

  window.Sfx = {
    unlock: () => ac(),
    toggle() { muted = !muted; return muted; },
    start: () => arp([262, 330, 392, 523], 0.08, { type: "square", vol: 0.1 }),
    tick: () => tone(880, 0.05, { type: "square", vol: 0.05 }),
    urgent: () => tone(1320, 0.07, { type: "square", vol: 0.08 }),
    guess: () => tone(520, 0.06, { type: "triangle", vol: 0.06 }),
    stroke: () => tone(300, 0.04, { type: "sine", vol: 0.03, slideTo: 420 }),
    match: () => arp([523, 659, 784, 1047, 1319], 0.06, { type: "square", vol: 0.11 }),
    fail: () => { tone(220, 0.25, { type: "sawtooth", vol: 0.1, slideTo: 110 }); tone(165, 0.35, { type: "sawtooth", vol: 0.08, at: 0.2, slideTo: 80 }); },
    fanfare() {
      arp([392, 523, 659, 784], 0.12, { type: "square", vol: 0.1 });
      tone(1047, 0.6, { type: "square", vol: 0.1, at: 0.5 });
      tone(784, 0.6, { type: "triangle", vol: 0.08, at: 0.5 });
    },
  };
})();
