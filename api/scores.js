// Leaderboards.
//   GET  /api/scores?board=daily|all&level=easy|normal|hard[&player=<id>]
//   POST /api/scores { board, level, player, name, score }
// "all" keeps each player's best score. "daily" counts only the first game a player
// posts that day, because after one game the day's prompts are known.
import { store } from "../lib/store.js";
import { isLevel, isPlayerId, cleanName, maxScore, today, json, readJson } from "../lib/rules.js";

const TOP = 20;
const DAILY_TTL = 3 * 24 * 3600;
const boardKey = (board, level, day) => (board === "daily" ? `lb:daily:${day}:${level}` : `lb:all:${level}`);

async function rankOf(key, player) {
  const score = await store.zscore(key, player);
  if (score === null) return null;
  return { rank: (await store.zcountAbove(key, score)) + 1, score };
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const board = q.get("board") === "daily" ? "daily" : "all";
  const level = q.get("level");
  if (!isLevel(level)) return json({ error: "Unknown level" }, 400);
  const day = today();
  const key = boardKey(board, level, day);

  const top = await store.ztop(key, TOP);
  const names = await store.hmget("names", top.map((t) => t.member));
  const entries = top.map((t, i) => ({ rank: i + 1, id: t.member, name: names[i] || "Anonymous", score: t.score }));
  const player = q.get("player");
  const me = isPlayerId(player) ? await rankOf(key, player) : null;
  return json({ board, level, day, entries, me });
}

export async function POST(request) {
  const body = await readJson(request);
  if (!body) return json({ error: "Expected JSON" }, 400);
  const { level, player } = body;
  const board = body.board === "daily" ? "daily" : "all";
  const name = cleanName(body.name);
  const score = Number(body.score);
  if (!isLevel(level)) return json({ error: "Unknown level" }, 400);
  if (!isPlayerId(player)) return json({ error: "Bad player id" }, 400);
  if (!name) return json({ error: "Name required" }, 400);
  if (!Number.isInteger(score) || score < 0 || score > maxScore(level)) return json({ error: "Impossible score" }, 400);

  const day = today();
  const key = boardKey(board, level, day);
  await store.hset("names", player, name);
  let counted = true;
  if (board === "daily") {
    counted = await store.zaddNX(key, player, score);
    await store.expire(key, DAILY_TTL);
  } else {
    await store.zaddGT(key, player, score);
  }
  return json({ board, level, day, counted, ...(await rankOf(key, player)) });
}
