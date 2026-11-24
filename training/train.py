"""Train the sketchX CNN on a subset of Google's Quick, Draw! dataset.

Usage:
    python training/train.py --data DIR --out public/model.js
DIR holds one <category>.npy (or .part) file per class, downloaded from
https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/<category>.npy
(a byte range covering the first N rows is enough; see README.md).
The result is a JS file that the browser game loads directly.
"""
import argparse, base64, json, math, os, time
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F

CLASSES = [
    # the original 24
    "cat", "fish", "house", "tree", "sun", "star", "car", "bicycle", "apple", "banana",
    "umbrella", "clock", "cup", "flower", "bird", "guitar", "airplane", "pizza", "snowman",
    "rainbow", "butterfly", "eyeglasses", "moon", "key",
    # animals
    "ant", "bear", "bee", "camel", "cow", "crab", "crocodile", "dog", "dolphin", "duck",
    "elephant", "flamingo", "frog", "giraffe", "horse", "kangaroo", "lion", "monkey",
    "octopus", "owl", "panda", "penguin", "pig", "rabbit", "scorpion", "shark", "sheep",
    "snail", "snake", "spider", "swan", "whale", "zebra", "sea turtle",
    # food
    "birthday cake", "broccoli", "carrot", "cookie", "donut", "grapes", "hamburger",
    "hot dog", "ice cream", "lollipop", "mushroom", "pear", "pineapple", "strawberry",
    "watermelon",
    # objects
    "backpack", "baseball bat", "basketball", "bed", "book", "cactus", "camera", "candle",
    "chair", "crown", "diamond", "door", "drums", "dumbbell", "envelope", "feather", "fork",
    "hammer", "hat", "headphones", "helmet", "hourglass", "ladder", "laptop", "light bulb",
    "lightning", "microphone", "parachute", "pencil", "piano", "scissors", "shovel",
    "skateboard", "spoon", "stop sign", "suitcase", "sword", "table", "teapot", "telephone",
    "television", "tennis racquet", "tent", "toilet", "toothbrush", "traffic light",
    "trumpet", "t-shirt", "vase", "violin", "wine glass", "wheel", "windmill", "snowflake",
    "skull", "smiley face",
    # vehicles
    "bus", "helicopter", "sailboat", "submarine", "tractor", "train", "truck",
    "hot air balloon", "motorbike", "flying saucer",
    # places and nature
    "castle", "bridge", "mountain", "tornado", "cloud", "The Eiffel Tower", "palm tree",
    "campfire", "fire hydrant",
    # body
    "hand", "eye",
]


# Channel widths. public/cnn.js reads them from the weight shapes, so they can change freely.
C1, C2, C3, HIDDEN = 48, 96, 192, 256


class SketchCNN(nn.Module):
    def __init__(self, n):
        super().__init__()
        self.c1 = nn.Conv2d(1, C1, 3, padding=1); self.b1 = nn.BatchNorm2d(C1)
        self.c2 = nn.Conv2d(C1, C2, 3, padding=1); self.b2 = nn.BatchNorm2d(C2)
        self.c3 = nn.Conv2d(C2, C3, 3, padding=1); self.b3 = nn.BatchNorm2d(C3)
        self.f1 = nn.Linear(C3 * 3 * 3, HIDDEN)
        self.f2 = nn.Linear(HIDDEN, n)
        self.drop = nn.Dropout(0.3)

    def forward(self, x):
        x = F.max_pool2d(F.relu(self.b1(self.c1(x))), 2)  # 14
        x = F.max_pool2d(F.relu(self.b2(self.c2(x))), 2)  # 7
        x = F.max_pool2d(F.relu(self.b3(self.c3(x))), 2)  # 3
        x = self.drop(F.relu(self.f1(x.flatten(1))))
        return self.f2(x)

    def export(self):
        """Fold each BatchNorm into its conv so the browser only runs conv → ReLU."""
        out = {}
        for c, b in (("c1", self.b1), ("c2", self.b2), ("c3", self.b3)):
            conv = getattr(self, c)
            k = b.weight / torch.sqrt(b.running_var + b.eps)
            out[c + ".weight"] = conv.weight * k.view(-1, 1, 1, 1)
            out[c + ".bias"] = (conv.bias - b.running_mean) * k + b.bias
        for f in ("f1", "f2"):
            out[f + ".weight"] = getattr(self, f).weight
            out[f + ".bias"] = getattr(self, f).bias
        return {k: v.detach().cpu() for k, v in out.items()}


def load(data_dir, per_class):
    xs, ys = [], []
    for i, c in enumerate(CLASSES):
        path = next(p for p in (os.path.join(data_dir, c + ext) for ext in (".npy", ".part")) if os.path.exists(p))
        raw = open(path, "rb").read()
        hlen = int.from_bytes(raw[8:10], "little") + 10  # npy v1 header
        a = np.frombuffer(raw[hlen:], dtype=np.uint8)
        a = a[: (len(a) // 784) * 784].reshape(-1, 28, 28)[:per_class]
        xs.append(a); ys.append(np.full(len(a), i, dtype=np.int64))
    return np.concatenate(xs), np.concatenate(ys)


def center(x):
    """Re-centre each uint8 bitmap on its bounding box, like the browser does."""
    ink = x > 12
    rows, cols = ink.any(2), ink.any(1)
    has = rows.any(1)
    r0 = rows.argmax(1); r1 = 27 - rows[:, ::-1].argmax(1)
    c0 = cols.argmax(1); c1 = 27 - cols[:, ::-1].argmax(1)
    out = np.zeros_like(x)
    for k in np.nonzero(has)[0]:
        h, w = r1[k] - r0[k] + 1, c1[k] - c0[k] + 1
        t, l = (28 - h) // 2, (28 - w) // 2
        out[k, t:t + h, l:l + w] = x[k, r0[k]:r1[k] + 1, c0[k]:c1[k] + 1]
    return out


def augment(x):
    n, dev = x.shape[0], x.device
    ang = (torch.rand(n, device=dev) - 0.5) * math.radians(24)
    s = 0.85 + torch.rand(n, device=dev) * 0.3
    tx, ty = (torch.rand(n, device=dev) - 0.5) * 0.2, (torch.rand(n, device=dev) - 0.5) * 0.2
    cos, sin = torch.cos(ang) / s, torch.sin(ang) / s
    theta = torch.stack([torch.stack([cos, -sin, tx], 1), torch.stack([sin, cos, ty], 1)], 1)
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    return F.grid_sample(x, grid, align_corners=False, padding_mode="zeros")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data")
    ap.add_argument("--list-classes", action="store_true", help="print the categories, one per line, and exit")
    ap.add_argument("--out", default="model.js")
    ap.add_argument("--per-class", type=int, default=10000)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=512)
    a = ap.parse_args()
    if a.list_classes:
        print("\n".join(CLASSES)); return
    if not a.data:
        ap.error("--data is required")
    torch.manual_seed(0); np.random.seed(0)
    dev = torch.device("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")

    t0 = time.time()
    X, Y = load(a.data, a.per_class)
    X = center(X)
    print(f"loaded {len(X)} drawings in {time.time() - t0:.0f}s, training on {dev}", flush=True)
    X = torch.from_numpy(X).to(dev)  # kept as uint8; converted to float per batch
    Y = torch.from_numpy(Y).to(dev)
    perm = torch.randperm(len(X), device=dev); X, Y = X[perm], Y[perm]
    nval = len(X) // 20
    Xv, Yv, Xt, Yt = X[:nval], Y[:nval], X[nval:], Y[nval:]
    print(f"train {len(Xt)}  val {len(Xv)}  classes {len(CLASSES)}", flush=True)
    as_float = lambda b: b.view(-1, 1, 28, 28).float() / 255.0

    m = SketchCNN(len(CLASSES)).to(dev)
    opt = torch.optim.AdamW(m.parameters(), 2e-3, weight_decay=1e-4)
    steps = a.epochs * math.ceil(len(Xt) / a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 3e-3, total_steps=steps)
    for ep in range(a.epochs):
        m.train(); p = torch.randperm(len(Xt), device=dev); t0 = time.time()
        for i in range(0, len(Xt), a.batch):
            idx = p[i:i + a.batch]
            loss = F.cross_entropy(m(augment(as_float(Xt[idx]))), Yt[idx], label_smoothing=0.05)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        m.eval()
        with torch.no_grad():
            acc = sum((m(as_float(Xv[i:i + 2048])).argmax(1) == Yv[i:i + 2048]).sum().item() for i in range(0, nval, 2048)) / nval
        print(f"epoch {ep + 1}: loss {loss.item():.3f}  val acc {acc:.4f}  ({time.time() - t0:.0f}s)", flush=True)

    # Weights ship as float16 to keep model.js small; cnn.js expands them to float32.
    layers = {}
    for k, v in m.export().items():
        arr = v.numpy().astype("<f2")
        layers[k] = {"shape": list(arr.shape), "dtype": "f16", "data": base64.b64encode(arr.tobytes()).decode()}
    meta = {"classes": CLASSES, "valAccuracy": round(acc, 4), "layers": layers}
    with open(a.out, "w") as f:
        f.write("// Generated by training/train.py: CNN weights trained on Quick, Draw! bitmaps.\n")
        f.write("window.SKETCH_MODEL = " + json.dumps(meta) + ";\n")
    print("wrote", a.out)


if __name__ == "__main__":
    main()
