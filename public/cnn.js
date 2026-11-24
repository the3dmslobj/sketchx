// Tiny dependency-free CNN inference engine for the sketchX model.
// Architecture (must match training/train.py; channel widths come from the weight shapes):
//   conv3x3(1→C1) → ReLU → maxpool2   28→14
//   conv3x3(C1→C2) → ReLU → maxpool2  14→7
//   conv3x3(C2→C3) → ReLU → maxpool2  7→3
//   dense(C3·9→H) → ReLU → dense(H→N) → softmax
(function () {
  // IEEE 754 half → float.
  function halfToFloat(h) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * f * 2 ** -24;
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * 2 ** (e - 15);
  }

  function decode(layer) {
    const bin = atob(layer.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (layer.dtype !== "f16") return new Float32Array(bytes.buffer);
    const half = new Uint16Array(bytes.buffer), out = new Float32Array(half.length);
    for (let i = 0; i < half.length; i++) out[i] = halfToFloat(half[i]);
    return out;
  }

  // input: Float32Array [cin*h*w]; weights [cout, cin, 3, 3]; padding 1. Applies ReLU.
  // im2col: lay out every 3×3 input patch once, then each output channel is a run of
  // long, contiguous multiply-adds, which V8 handles far faster than nested short loops.
  function conv3x3Relu(input, cin, h, w, weight, bias, cout) {
    const hw = h * w, K = cin * 9;
    const col = new Float32Array(K * hw);
    for (let i = 0; i < cin; i++) {
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const cb = (i * 9 + ky * 3 + kx) * hw, dy = ky - 1, dx = kx - 1;
          const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
          for (let y = Math.max(0, -dy), y1 = Math.min(h, h - dy); y < y1; y++) {
            const crow = cb + y * w, irow = i * hw + (y + dy) * w + dx;
            for (let x = x0; x < x1; x++) col[crow + x] = input[irow + x];
          }
        }
      }
    }
    const out = new Float32Array(cout * hw);
    for (let o = 0; o < cout; o++) {
      const ob = o * hw, wb = o * K;
      out.fill(bias[o], ob, ob + hw);
      for (let j = 0; j < K; j++) {
        const k = weight[wb + j];
        if (k === 0) continue;
        const cb = j * hw;
        for (let p = 0; p < hw; p++) out[ob + p] += k * col[cb + p];
      }
      for (let p = ob; p < ob + hw; p++) if (out[p] < 0) out[p] = 0;
    }
    return out;
  }

  function maxPool2(input, c, h, w) {
    const oh = Math.floor(h / 2), ow = Math.floor(w / 2);
    const out = new Float32Array(c * oh * ow);
    for (let ch = 0; ch < c; ch++) {
      for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
          const b = ch * h * w + 2 * y * w + 2 * x;
          out[ch * oh * ow + y * ow + x] = Math.max(input[b], input[b + 1], input[b + w], input[b + w + 1]);
        }
      }
    }
    return out;
  }

  function dense(input, weight, bias, nout, relu) {
    const nin = input.length;
    const out = new Float32Array(nout);
    for (let o = 0; o < nout; o++) {
      let s = bias[o];
      const wb = o * nin;
      for (let i = 0; i < nin; i++) s += weight[wb + i] * input[i];
      out[o] = relu ? Math.max(0, s) : s;
    }
    return out;
  }

  function softmax(v) {
    const m = Math.max(...v);
    const e = Array.from(v, (x) => Math.exp(x - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  }

  class SketchCNN {
    constructor(model) {
      this.classes = model.classes;
      this.w = {};
      for (const [k, v] of Object.entries(model.layers)) this.w[k] = decode(v);
    }

    // pixels: Float32Array(784), 0 = background, 1 = ink. Returns [{label, p}] sorted.
    // temperature > 1 divides the logits before softmax, which tempers the model's
    // overconfidence on bare shapes (a lone arc otherwise reads as "rainbow 99%").
    predict(pixels, temperature = 1) {
      const w = this.w;
      const c1 = w["c1.bias"].length, c2 = w["c2.bias"].length, c3 = w["c3.bias"].length;
      let x = conv3x3Relu(pixels, 1, 28, 28, w["c1.weight"], w["c1.bias"], c1);
      x = maxPool2(x, c1, 28, 28);
      x = conv3x3Relu(x, c1, 14, 14, w["c2.weight"], w["c2.bias"], c2);
      x = maxPool2(x, c2, 14, 14);
      x = conv3x3Relu(x, c2, 7, 7, w["c3.weight"], w["c3.bias"], c3);
      x = maxPool2(x, c3, 7, 7);
      x = dense(x, w["f1.weight"], w["f1.bias"], w["f1.bias"].length, true);
      x = dense(x, w["f2.weight"], w["f2.bias"], this.classes.length, false);
      if (temperature !== 1) for (let i = 0; i < x.length; i++) x[i] /= temperature;
      return softmax(x)
        .map((p, i) => ({ label: this.classes[i], p }))
        .sort((a, b) => b.p - a.p);
    }
  }

  // Turn vector strokes into a 28×28 bitmap that looks like a Quick, Draw! sample:
  // crop to the bounding box, scale the longest side to fill the frame, centre it.
  function rasterize(strokes) {
    const pts = strokes.flat();
    if (pts.length < 2) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const S = 256, lw = 16, pad = lw / 2 + 2;
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const scale = (S - 2 * pad) / span;
    const ox = (S - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = (S - (maxY - minY) * scale) / 2 - minY * scale;

    const big = document.createElement("canvas");
    big.width = big.height = S;
    const g = big.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, S, S);
    g.strokeStyle = "#fff"; g.lineWidth = lw; g.lineCap = "round"; g.lineJoin = "round";
    for (const s of strokes) {
      g.beginPath();
      s.forEach((p, i) => (i ? g.lineTo(p.x * scale + ox, p.y * scale + oy) : g.moveTo(p.x * scale + ox, p.y * scale + oy)));
      if (s.length === 1) g.lineTo(s[0].x * scale + ox + 0.1, s[0].y * scale + oy);
      g.stroke();
    }
    // Downscale in halving steps for smooth anti-aliasing (256→128→64→28).
    let src = big;
    for (const size of [128, 64, 28]) {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const cg = c.getContext("2d");
      cg.imageSmoothingEnabled = true; cg.imageSmoothingQuality = "high";
      cg.drawImage(src, 0, 0, size, size);
      src = c;
    }
    const data = src.getContext("2d").getImageData(0, 0, 28, 28).data;
    const out = new Float32Array(784);
    for (let i = 0; i < 784; i++) out[i] = data[i * 4] / 255;
    return out;
  }

  window.SketchCNN = SketchCNN;
  window.rasterizeStrokes = rasterize;
})();
