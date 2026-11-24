// Game rules the server needs to validate what clients send.
// Keep in sync with LEVELS / ROUNDS / scoring in public/game.js.
export const ROUNDS = 5;
export const BASE_POINTS = 500;
export const POINTS_PER_SECOND = 50;
export const LEVEL_TIME = { easy: 25, normal: 20, hard: 15 }; // seconds per round

export const isLevel = (l) => Object.hasOwn(LEVEL_TIME, l);
export const maxScore = (level) => ROUNDS * (BASE_POINTS + POINTS_PER_SECOND * LEVEL_TIME[level]);
export const today = () => new Date().toISOString().slice(0, 10); // UTC day, e.g. 2026-11-24

// Player ids are random UUIDs the browser keeps in localStorage.
export const isPlayerId = (id) => typeof id === "string" && /^[a-zA-Z0-9-]{8,40}$/.test(id);

// 1–16 visible characters, no control characters or angle brackets, collapsed spaces.
export function cleanName(name) {
  if (typeof name !== "string") return null;
  const n = name.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return n.length ? n : null;
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
