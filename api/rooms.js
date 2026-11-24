// Live rooms: friends play the same prompts at the same moment and see a shared ranking.
//   GET  /api/rooms?code=ABCD                    -> room state (clients poll this)
//   POST /api/rooms { action: "create", player, name, level }
//   POST /api/rooms { action: "join",   code, player, name }
//   POST /api/rooms { action: "start",  code, player }          (host only; also starts the next game)
//   POST /api/rooms { action: "progress", code, player, round, score, matched, done }
//   POST /api/rooms { action: "reset",  code, player }          (host only: back to the lobby)
//   POST /api/rooms { action: "leave",  code, player }
// Room data:  room:<code>          hash  host, level, status (lobby|playing), seed, startAt, game
//             room:<code>:players  hash  <player id> -> JSON { name, score, round, matched, done, game }
// Each player only writes their own field, so concurrent updates never clobber each other.
import { store } from "../lib/store.js";
import { ROUNDS, isLevel, isPlayerId, cleanName, maxScore, json, readJson } from "../lib/rules.js";

const TTL = 3 * 3600; // rooms disappear 3 hours after their last activity
const MAX_PLAYERS = 12;
const COUNTDOWN_MS = 4000;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O

const roomKey = (code) => `room:${code}`;
const playersKey = (code) => `room:${code}:players`;
const cleanCode = (c) => (typeof c === "string" && /^[A-Za-z]{4}$/.test(c) ? c.toUpperCase() : null);
const randomCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");

async function touch(code) {
  await Promise.all([store.expire(roomKey(code), TTL), store.expire(playersKey(code), TTL)]);
}

async function readRoom(code) {
  const [room, players] = await Promise.all([store.hgetall(roomKey(code)), store.hgetall(playersKey(code))]);
  if (!room.host) return null;
  const game = Number(room.game || 0);
  const list = Object.entries(players)
    .map(([id, raw]) => [id, JSON.parse(raw)])
    .filter(([, p]) => !p.left)
    .map(([id, p]) => {
      // Progress from an earlier game in this room does not count after a replay.
      const fresh = p.game === game;
      return {
        id, name: p.name, isHost: id === room.host,
        score: fresh ? p.score : 0, round: fresh ? p.round : 0, matched: fresh ? p.matched : 0, done: fresh && p.done,
      };
    })
    .sort((a, b) => b.score - a.score || b.round - a.round || a.name.localeCompare(b.name));
  return {
    code, host: room.host, level: room.level, status: room.status, game,
    seed: Number(room.seed || 0), startAt: Number(room.startAt || 0), serverNow: Date.now(),
    rounds: ROUNDS, players: list,
  };
}

async function writePlayer(code, player, fields) {
  const raw = await store.hget(playersKey(code), player);
  const prev = raw ? JSON.parse(raw) : {};
  await store.hset(playersKey(code), player, JSON.stringify({ ...prev, ...fields }));
}

export async function GET(request) {
  const code = cleanCode(new URL(request.url).searchParams.get("code"));
  if (!code) return json({ error: "Room codes are 4 letters" }, 400);
  const room = await readRoom(code);
  return room ? json(room) : json({ error: "Room not found" }, 404);
}

export async function POST(request) {
  const body = await readJson(request);
  if (!body) return json({ error: "Expected JSON" }, 400);
  const { action, player } = body;
  if (!isPlayerId(player)) return json({ error: "Bad player id" }, 400);

  if (action === "create") {
    const name = cleanName(body.name);
    if (!name) return json({ error: "Name required" }, 400);
    if (!isLevel(body.level)) return json({ error: "Unknown level" }, 400);
    let code = null;
    for (let i = 0; i < 20 && !code; i++) {
      const c = randomCode();
      if (await store.hsetnx(roomKey(c), "host", player)) code = c;
    }
    if (!code) return json({ error: "Could not find a free room code, try again" }, 503);
    await store.hsetMany(roomKey(code), { level: body.level, status: "lobby", game: 0, seed: 0, startAt: 0 });
    await writePlayer(code, player, { name, score: 0, round: 0, matched: 0, done: false, game: 0 });
    await touch(code);
    return json(await readRoom(code));
  }

  const code = cleanCode(body.code);
  if (!code) return json({ error: "Room codes are 4 letters" }, 400);
  const room = await store.hgetall(roomKey(code));
  if (!room.host) return json({ error: "Room not found" }, 404);
  const isHost = room.host === player;
  const game = Number(room.game || 0);

  if (action === "join") {
    const name = cleanName(body.name);
    if (!name) return json({ error: "Name required" }, 400);
    const players = await store.hgetall(playersKey(code));
    const active = Object.values(players).filter((raw) => !JSON.parse(raw).left).length;
    if (!players[player] && active >= MAX_PLAYERS) return json({ error: "Room is full" }, 409);
    const known = players[player] && !JSON.parse(players[player]).left;
    if (!known && room.status !== "lobby") return json({ error: "That game has already started" }, 409);
    await writePlayer(code, player, { name, left: false, ...(known ? {} : { score: 0, round: 0, matched: 0, done: false, game }) });
  } else if (action === "start") {
    if (!isHost) return json({ error: "Only the host can start" }, 403);
    // Allowed from the lobby or after a game, so the host can go straight to the next one.
    if (room.status === "playing" && Number(room.startAt) > Date.now()) return json({ error: "Already starting" }, 409);
    await store.hsetMany(roomKey(code), {
      status: "playing", game: game + 1, seed: Math.floor(Math.random() * 2 ** 31), startAt: Date.now() + COUNTDOWN_MS,
    });
  } else if (action === "progress") {
    const players = await store.hgetall(playersKey(code));
    if (!players[player]) return json({ error: "Not in this room" }, 403);
    const score = Number(body.score), round = Number(body.round), matched = Number(body.matched);
    if (room.status !== "playing") return json({ error: "No game running" }, 409);
    if (!Number.isInteger(round) || round < 0 || round > ROUNDS) return json({ error: "Bad round" }, 400);
    if (!Number.isInteger(score) || score < 0 || score > maxScore(room.level)) return json({ error: "Impossible score" }, 400);
    if (!Number.isInteger(matched) || matched < 0 || matched > round) return json({ error: "Bad match count" }, 400);
    await writePlayer(code, player, { score, round, matched, done: !!body.done, game });
  } else if (action === "reset") {
    if (!isHost) return json({ error: "Only the host can do that" }, 403);
    await store.hsetMany(roomKey(code), { status: "lobby", startAt: 0 });
  } else if (action === "leave") {
    const players = await store.hgetall(playersKey(code));
    if (players[player]) await writePlayer(code, player, { left: true });
    if (isHost) {
      // Hand the room to someone who is still here.
      const next = Object.entries(players).find(([id, raw]) => id !== player && !JSON.parse(raw).left);
      if (next) await store.hset(roomKey(code), "host", next[0]);
    }
  } else {
    return json({ error: "Unknown action" }, 400);
  }
  await touch(code);
  return json(await readRoom(code));
}
