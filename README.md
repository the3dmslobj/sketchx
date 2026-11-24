# sketchX

A real-time drawing game where you race a neural network. You get a random prompt and a
few seconds to sketch it. A convolutional neural network (CNN) trained on Google's
[Quick, Draw!](https://quickdraw.withgoogle.com/data) dataset knows 150 objects, watches
every stroke, shows its live top-3 guesses, and declares a match once it has been sure
enough, for long enough, that your drawing is the prompt.

## Difficulty

Pick a level on the start screen (it is remembered between visits):

| Level | Time per drawing | AI must be | Held for | Real Quick, Draw! doodles that pass |
| --- | --- | --- | --- | --- |
| Easy | 25 s | 60% sure | 0.3 s | about 67% |
| Normal | 20 s | 80% sure | 0.5 s | about 53% |
| Hard | 15 s | 85% sure, scores softened (temperature 1.2) | 0.75 s | about 33% |

The levels live in `LEVELS` at the top of `public/game.js`. Bear, bird, violin and duck
are left out of the prompts (`NOT_PROMPTS`) because even Easy recognizes only 0 to 14%
of real drawings of them; the AI can still guess them.

## Play

```bash
npm install
npm run dev
```

Then open http://localhost:3000. Locally, leaderboards and rooms live in memory and reset
when the server restarts. Opening `public/index.html` straight from disk still runs the
solo game, but without the online features.

## Modes

- **Play solo**: 5 random prompts. With a name entered, your best score goes on the
  all-time leaderboard for that difficulty.
- **Daily challenge**: the same 5 prompts for everyone that day (UTC). Only your first
  game of the day counts on the daily leaderboard.
- **Play with friends**: create a room and share its 4-letter code or invite link. Up to
  12 players join a lobby; when the host starts, everyone gets the same prompts after a
  4-second countdown and sees a live ranking. The host can start the next game from the
  results screen.

Players are identified by a random id kept in the browser plus the name they type; there
are no accounts. Scores are checked against the maximum possible for the difficulty, but
a determined player could still post a fake score, since the game runs in the browser.

## Deploy to Vercel

The site is the static `public/` folder plus two Vercel Functions, `api/scores.js` and
`api/rooms.js`, which store data in Redis (Upstash, from the Vercel Marketplace).

```bash
vercel login
vercel link
vercel integration add upstash   # creates a Redis database and adds its env vars
vercel deploy --prod
```

The functions read `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN`). To use the real database locally, run `vercel env pull .env`
and start the dev server with `node --env-file=.env dev-server.mjs`.

Rooms are synchronized by polling `GET /api/rooms` every 1.5 seconds rather than by
WebSockets, so they work on any plan without extra setup. Rooms expire 3 hours after
their last activity; daily leaderboards after 3 days.

## How it works

| Part | Tech |
| --- | --- |
| Drawing | HTML5 Canvas with Pointer Events (mouse, touch, pen) |
| AI | 3-layer CNN (about 690k parameters, float16 weights) that recognizes 150 objects, run in pure JavaScript (`public/cnn.js`) |
| Sound | Web Audio API oscillators (`public/audio.js`), no audio files |
| Styling | Tailwind CSS (prebuilt `public/tailwind.css`), clean minimal light theme |
| Online | Vercel Functions (`api/`) + Upstash Redis; local `dev-server.mjs` with an in-memory store |

**Each round:** prompt → 15 to 25 s sketch (depending on the level) → live AI predictions → points. There are 5 rounds per game.

**Preprocessing:** the strokes are cropped to their bounding box, scaled to fill the
frame, centred, and anti-aliased down to 28×28 pixels, which is the format of the
Quick, Draw! bitmaps the model was trained on. The 28×28 thumbnail under the AI panel
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

## Styling

After changing classes in `public/index.html` or `public/game.js`, rebuild the CSS:

```bash
npm install
npm run build:css
```

## Retraining the model

`training/train.py` trains the CNN and writes `public/model.js`. It uses an NVIDIA GPU
or Apple Silicon GPU when available; on an M-series Mac the 150-class model takes about
half an hour.

```bash
pip install torch numpy
mkdir -p data
python training/train.py --list-classes | tr '\n' '\0' | xargs -0 -P 8 -I{} sh -c \
  'curl -sf -r 0-7840127 -o "data/$1.part" "https://storage.googleapis.com/quickdraw_dataset/full/numpy_bitmap/$(printf %s "$1" | sed "s/ /%20/g").npy"' _ {}
python training/train.py --data data --out public/model.js
```

The byte range downloads the first 10,000 drawings of each category (about 1.2 GB in
total). To add or change categories, edit `CLASSES` in `train.py`; any of the
[345 Quick, Draw! categories](https://github.com/googlecreativelab/quickdraw-dataset/blob/master/categories.txt)
works.
