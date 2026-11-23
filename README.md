# Sketch Duel: Human vs AI

A real-time drawing game where you race a neural network. You get a random prompt and
20 seconds to sketch it. A convolutional neural network (CNN) trained on Google's
[Quick, Draw!](https://quickdraw.withgoogle.com/data) dataset watches every stroke,
shows its live top-3 guesses, and declares a match as soon as it is at least **70%**
confident that your drawing is the prompt.

## Play

The game is static HTML/JS and needs no build step. Serve the `public/` folder:

```bash
python3 -m http.server 8000 --directory public
```

Then open http://localhost:8000. Opening `public/index.html` straight from disk also works.

## How it works

| Part | Tech |
| --- | --- |
| Drawing | HTML5 Canvas with Pointer Events (mouse, touch, pen) |
| AI | 3-layer CNN (about 245k parameters) that recognizes 24 objects, run in pure JavaScript (`public/cnn.js`) |
| Sound | Web Audio API oscillators (`public/audio.js`), no audio files |
| Styling | Tailwind CSS (Play CDN), dark arcade theme |

**Each round:** prompt → 20 s sketch → live AI predictions → points. There are 5 rounds per game.

**Preprocessing:** the strokes are cropped to their bounding box, scaled to fill the
frame, centred, and anti-aliased down to 28×28 pixels, which is the format of the
Quick, Draw! bitmaps the model was trained on. The "AI vision" thumbnail in the game
shows exactly this input.

**Scoring:** a match earns 500 base points plus 50 points for every second left on the
clock. Ranks:

| Score | Rank |
| --- | --- |
| 0–1499 | Doodle Rookie |
| 1500–3499 | Sketch Cadet |
| 3500–6000 | Pixel Pro |
| over 6000 | **AI Whisperer** |

When the game ends, you get a summary of every round: your sketch, the time it took,
the AI's confidence (or its best wrong guess), and your points.

## Retraining the model

`training/train.py` trains the CNN and writes `public/model.js`.

```bash
pip install torch numpy
mkdir -p data
for c in cat fish house tree sun star car bicycle apple banana umbrella clock cup flower bird guitar airplane pizza snowman rainbow butterfly eyeglasses moon key; do
  curl -s -r 0-9408127 -o data/$c.part https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/$c.npy
done
python training/train.py --data data --out public/model.js
```

The byte range downloads the first 12,000 drawings of each category. To add or change
categories, edit `CLASSES` in `train.py` and the emoji map in `public/game.js`.
