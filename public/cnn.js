// Tiny dependency-free CNN inference engine for the Sketch Duel model.
// Architecture (must match training/train.py):
//   conv3x3(1→32) → ReLU → maxpool2   28→14
//   conv3x3(32→64) → ReLU → maxpool2  14→7
//   conv3x3(64→128) → ReLU → maxpool2 7→3
//   dense(1152→128) → ReLU → dense(128→N) → softmax
(function () {
  function decode(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  // input: Float32Array [cin*h*w]; weights [cout, cin, 3, 3]; padding 1. Applies ReLU.
  function conv3x3Relu(input, cin, h, w, weight, bias, cout) {
    const out = new Float32Array(cout * h * w);
    for (let o = 0; o < cout; o++) {
      const ob = o * h * w;
      for (let i = 0; i < cin; i++) {
        const ib = i * h * w;
        const wb = (o * cin + i) * 9;
        for (let ky = 0; ky < 3; ky++) {
          for (let kx = 0; kx < 3; kx++) {
            const k = weight[wb + ky * 3 + kx];
            if (k === 0) continue;
            const dy = ky - 1, dx = kx - 1;
            const y0 = Math.max(0, -dy), y1 = Math.min(h, h - dy);
            const x0 = Math.max(0, -dx), x1 = Math.min(w, w - dx);
            for (let y = y0; y < y1; y++) {
              const orow = ob + y * w, irow = ib + (y + dy) * w + dx;
              for (let x = x0; x < x1; x++) out[orow + x] += k * input[irow + x];
            }
          }
        }
      }
      const b = bias[o];
      for (let p = ob; p < ob + h * w; p++) out[p] = Math.max(0, out[p] + b);
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
      for (const [k, v] of Object.entries(model.layers)) this.w[k] = decode(v.data);
    }

    // pixels: Float32Array(784), 0 = background, 1 = ink. Returns [{label, p}] sorted.
    predict(pixels) {
      const w = this.w;
      let x = conv3x3Relu(pixels, 1, 28, 28, w["c1.weight"], w["c1.bias"], 32);
      x = maxPool2(x, 32, 28, 28);
      x = conv3x3Relu(x, 32, 14, 14, w["c2.weight"], w["c2.bias"], 64);
      x = maxPool2(x, 64, 14, 14);
      x = conv3x3Relu(x, 64, 7, 7, w["c3.weight"], w["c3.bias"], 128);
      x = maxPool2(x, 128, 7, 7);
      x = dense(x, w["f1.weight"], w["f1.bias"], 128, true);
      x = dense(x, w["f2.weight"], w["f2.bias"], this.classes.length, false);
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
