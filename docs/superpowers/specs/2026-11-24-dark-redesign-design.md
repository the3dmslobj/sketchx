# sketchX dark redesign

Date: 2026-11-24

## Intent

Give sketchX a whole new structure and a deeply refined, dark, clean UI. The owner likes
the current minimal feel ("keep it clean, it's okay") but wants it rebuilt: new layout,
dark mode, Phosphor icons, and much more care in the details (spacing, type, borders,
states, motion). Success is a game that looks and feels like a polished product, not a
styled form, while every existing feature keeps working.

## Goals

- New app structure: an app shell with navigation for the menu views, and a full-screen,
  distraction-free drawing stage for the game.
- Dark only, clean, restrained: layered near-black surfaces, hairline borders, one accent.
- Phosphor icons everywhere an icon helps (navigation, tools, status, medals, copy, sound).
- Refined details: consistent spacing scale, type scale, tabular numbers, hover / active /
  focus-visible / disabled states on every control, small purposeful motion, good mobile
  layout.

## Non-goals

- No changes to the AI (`cnn.js`, `model.js`), scoring, difficulty levels, prompts, rules,
  API (`api/`, `lib/`), or sound (`audio.js`).
- No framework, bundler, or build step beyond the existing Tailwind CSS build.
- No light theme or theme toggle.

## Anti-goals (a failure even if it works)

- A neon / "gamer" look, glows everywhere, or more than one accent colour.
- Clutter: panels that compete with the canvas while drawing.
- Breaking room sync, the daily challenge rules, invite links, or leaderboards.
- Hurting recognition. (The model rasterizes stroke points itself in `rasterizeStrokes`,
  not canvas pixels, so canvas colours are free to change.)
- A worse phone experience than today.

## Constraints

- Static site: `public/index.html` + plain browser scripts, Tailwind 3.4 prebuilt into
  `public/tailwind.css` via `npm run build:css` (content scan covers `public/**/*.{html,js}`,
  so classes in `game.js` template strings are picked up). Rebuild CSS after changes.
- `game.js` finds elements by id and toggles Tailwind classes; any id or class contract the
  redesign changes must be updated in `game.js` too.
- Opening `public/index.html` from disk must still run solo play.

## Approaches

1. **Refined version of today's layout.** Same centred column, restyled. Smallest change
   to `game.js`. Rejected: the owner asked for a whole new structure.
2. **App shell + full-screen stage (picked).** Menu views live in a shell with a nav rail;
   the game takes over the whole viewport with floating panels around the canvas. More
   `game.js` work (view switching, panels, result sheet, mobile), but it's the new
   structure asked for and gives the canvas the most room.
3. **One long scrolling landing page with the game embedded.** Rejected: it makes the game
   feel like a section of a marketing page and fights the focused drawing experience.

## Visual system (builder's calls, proposed)

- **Colour:** background `#09090b` (zinc-950); surfaces zinc-900 at ~60% with
  `border-white/[.06]`–`[.08]`; raised surfaces (popovers, sheets) zinc-900 solid with a
  subtle top inner highlight (`inset 0 1px 0 rgb(255 255 255 / .04)`). Text: zinc-100
  primary, zinc-400 secondary, zinc-500 tertiary. Primary buttons: zinc-100 background,
  zinc-950 text. **Accent: emerald-400** only for match / correct / "you". **Red-400**
  only for urgency (last 5 s, errors).
- **Type:** Geist for UI, Geist Mono for numbers (timer, score, room code, ranks), loaded
  from Google Fonts. Tight tracking on headings; small uppercase-free labels in zinc-500.
- **Icons:** `@phosphor-icons/web` from a pinned CDN version (regular weight for UI,
  fill weight for active nav / status). Used as `<i class="ph ph-...">`.
- **Radius / spacing:** 12 px cards, 10 px buttons, 8 px inputs; 4 px spacing grid.
- **Motion:** 150–250 ms ease-out for hovers, view enter (fade + 4 px rise), sheet slide
  up, bar widths; respects `prefers-reduced-motion`.
- **Canvas:** zinc-950 with a faint dot grid, ink zinc-100. Round thumbnails and the
  28×28 "AI eye" switch to light-on-dark to match.

## Structure

### App shell (all views except the game)

- **Desktop:** fixed left nav rail (~64 px, icons with tooltips, or ~200 px with labels on
  wide screens — builder's call) with the sketchX mark at top, then **Play**, **Daily**,
  **Friends**, **Leaderboard**; sound toggle and the player's name chip at the bottom.
- **Mobile:** the rail becomes a bottom tab bar with the same four items; sound and name
  move into the Play view header.
- The active item uses the fill icon and a zinc-800 pill.

### Play (home)

- Left: headline, one-line explanation, name input, difficulty picker as three selectable
  cards (Easy / Normal / Hard, each showing seconds per drawing and the confidence needed),
  primary "Play solo" button. Model info ("AI knows 150 objects · 9x.x% accuracy") as a
  quiet footnote.
- Right (desktop) / below (mobile): a "How it works" strip (prompt → sketch → AI guesses →
  score) with Phosphor icons, and a small card linking to today's challenge with its status.

### Daily

- Today's date (UTC), what the challenge is (same 5 prompts for everyone, first game
  counts), the selected difficulty, and either a Start button or "You scored N today".
- Today's top players for that difficulty underneath (reuses the leaderboard fetch).
- Starting still requires a name (current `requireName` behaviour).

### Friends (rooms)

- Join view: two cards side by side (stacked on mobile): "Create a room" (shows the
  difficulty it will use, changeable right there) and "Join with a code" (4-letter code
  input styled as four boxes or one wide mono input).
- Lobby: large mono room code with a copy-invite-link icon button, difficulty line,
  player list with initial avatars and host badge, Start (host) / waiting text (guests),
  Leave.

### Leaderboard

- Segmented controls for board (Today / All time) and difficulty.
- Ranked list; top 3 get Phosphor medal / crown icons; the player's own row highlighted
  with the emerald accent and "(you)"; their row appended if outside the top list.

### Game (full-screen stage, nav hidden)

- **Top bar:** exit button (X), five round pips (empty / current / matched in emerald / missed), the prompt
  large in the centre ("Draw" label + word), timer (mono number plus a thin progress line
  along the bottom of the top bar, red in the last 5 s), score.
- **Layout (desktop):** below the top bar, the stage is two columns: the drawing board on
  the left fills all remaining width and height; a docked sidebar (~300 px) on the right.
  Nothing floats over the board, so strokes never pass under a panel.
- **Board:** a large rounded canvas (not the raw viewport) that fills its column; ink width
  scales with `min(width, height)` instead of width alone. `resizeBoard` handles DPR.
- **Sidebar:** AI card (status dot + text, the AI's thought, top-3 guesses with bars, the
  28×28 eye with the match threshold) and, in rooms, a live ranking card below it.
- **Mobile:** top bar, then a compact AI strip (top guess + percentage), then the board,
  then the toolbar. In rooms, the top bar shows a chip with your position ("#2 of 5");
  tapping it opens a bottom sheet with the full live ranking.
- **Toolbar:** a pill directly under the board (not over it): Undo, Clear, Skip, each with
  icon and keyboard hint on desktop.
- **Exit (X):** asks for confirmation in a small inline popover anchored to the button
  ("Leave this game?" Leave / Stay), so a stray tap does nothing. Solo: returns to Play,
  no score saved. Daily: exiting counts as your game for the day: it is marked played and
  the partial score so far is submitted, so prompts can't be previewed and replayed.
  Rooms: leaves the room (same as today's Leave). Shortcuts (builder's call to add): Cmd/Ctrl+Z undo, Enter
  continues after a round (exists today).
- **Countdown (rooms):** centred over the canvas, large mono number.
- **Round result:** a sheet that slides up over the bottom of the canvas (not a full
  overlay), showing Match (emerald, with confidence, time, points and speed bonus) or
  Time's up / Skipped (with what the AI thought), and the Next round / See results button.
  The miss shake stays.

### Results

- Two columns on desktop: left — final score (large mono), rank name and hint, three stats
  (recognized, avg. time, fastest), round sketches as a five-card strip with per-round
  result; right — the online card (leaderboard or room ranking, with the existing notes and
  "waiting for host" behaviour). Play again / Home (or Start next game / Leave room).
  Stacked on mobile.

### Name

- The name lives in one place in state but can be edited from: the Play view input, and
  the name chip in the rail (desktop) / Play header (mobile), which opens a small popover
  with the input.
- Daily and Friends can be opened without a name. When an action needs one (Start daily,
  Create, Join), and the name is empty, an inline name field appears in that view's card,
  focused, with the hint "Enter a name first". No redirect to Play.
- Invite links (`?room=ABCD`) open Friends with the code filled in; with a name they join
  straight away (as today); without one, the inline name field shows "Enter a name to join
  room ABCD".

### Rooms and navigation

- Being in a room does not lock the nav. A player in a lobby (or on room results) can open
  Leaderboard or Play; they stay in the room and polling continues. The Friends nav item
  shows a small emerald dot while in a room, and opening it returns to the lobby.
- If the host starts a game while the player is on another tab, they are pulled into the
  game with the normal countdown (as the synced start already does).
- Starting a solo or daily game while in a room first leaves the room.
- Leaving is explicit: the Leave button in the lobby / results, or the game's exit.

## Behaviour that must be preserved

Everything in `game.js` today: difficulty persistence, daily once-per-day rule and its
button state, leaderboard saving and display, rooms (create, join, poll, synced start,
progress, host-only start, leave, closed-room message), invite links (`?room=ABCD`),
name requirement for online modes, mute toggle, Enter to continue, solo play from disk.

## Left to the builder

- Exact Tailwind classes, shades within the palette above, and icon choices.
- Whether the rail shows labels on wide screens.
- How `game.js` is reorganised internally, as long as behaviour is preserved.
- Whether to add a small shared helper for segmented controls / view switching.
