// Tiny storage layer: Upstash Redis when its env vars are set (Vercel Marketplace adds
// them), otherwise an in-memory stand-in so the game also runs locally with no setup.
// Values are always strings; callers JSON-encode what they store.
import { Redis } from "@upstash/redis";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// With automaticDeserialization off, hash reads come back as flat arrays
// (["field", "value", ...]) for HGETALL and positional arrays for HMGET.
const pairsToObject = (res) => {
  if (!res) return {};
  if (!Array.isArray(res)) return res;
  const out = {};
  for (let i = 0; i < res.length; i += 2) out[res[i]] = res[i + 1];
  return out;
};

function redisStore() {
  const r = new Redis({ url, token, automaticDeserialization: false });
  return {
    kind: "redis",
    zaddGT: (key, member, score) => r.zadd(key, { gt: true }, { score, member }),
    zaddNX: async (key, member, score) => (await r.zadd(key, { nx: true }, { score, member })) === 1,
    async ztop(key, n) {
      const flat = await r.zrange(key, 0, n - 1, { rev: true, withScores: true });
      const out = [];
      for (let i = 0; i < flat.length; i += 2) out.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
      return out;
    },
    zscore: async (key, member) => {
      const s = await r.zscore(key, member);
      return s === null || s === undefined ? null : Number(s);
    },
    zcountAbove: (key, score) => r.zcount(key, `(${score}`, "+inf"),
    hset: (key, field, value) => r.hset(key, { [field]: value }),
    hsetMany: (key, obj) => r.hset(key, obj),
    hsetnx: async (key, field, value) => (await r.hsetnx(key, field, value)) === 1,
    hget: (key, field) => r.hget(key, field),
    hmget: async (key, fields) => {
      if (!fields.length) return [];
      const res = await r.hmget(key, ...fields);
      if (Array.isArray(res)) return fields.map((_, i) => res[i] ?? null);
      return fields.map((f) => (res && res[f] !== undefined ? res[f] : null));
    },
    hgetall: async (key) => pairsToObject(await r.hgetall(key)),
    expire: (key, seconds) => r.expire(key, seconds),
  };
}

function memoryStore() {
  const db = new Map(); // key -> { value: Map, expiresAt }
  const get = (key, create) => {
    let e = db.get(key);
    if (e && e.expiresAt && e.expiresAt < Date.now()) { db.delete(key); e = undefined; }
    if (!e && create) { e = { value: new Map(), expiresAt: 0 }; db.set(key, e); }
    return e;
  };
  const sorted = (key) => [...(get(key)?.value || new Map())].sort((a, b) => b[1] - a[1]);
  return {
    kind: "memory",
    async zaddGT(key, member, score) {
      const m = get(key, true).value;
      if (!m.has(member) || score > m.get(member)) m.set(member, score);
    },
    async zaddNX(key, member, score) {
      const m = get(key, true).value;
      if (m.has(member)) return false;
      m.set(member, score);
      return true;
    },
    ztop: async (key, n) => sorted(key).slice(0, n).map(([member, score]) => ({ member, score })),
    zscore: async (key, member) => get(key)?.value.get(member) ?? null,
    zcountAbove: async (key, score) => sorted(key).filter(([, s]) => s > score).length,
    async hset(key, field, value) { get(key, true).value.set(field, String(value)); },
    async hsetMany(key, obj) { const m = get(key, true).value; for (const [f, v] of Object.entries(obj)) m.set(f, String(v)); },
    async hsetnx(key, field, value) {
      const m = get(key, true).value;
      if (m.has(field)) return false;
      m.set(field, String(value));
      return true;
    },
    hget: async (key, field) => get(key)?.value.get(field) ?? null,
    hmget: async (key, fields) => fields.map((f) => get(key)?.value.get(f) ?? null),
    hgetall: async (key) => Object.fromEntries(get(key)?.value || []),
    async expire(key, seconds) { const e = get(key); if (e) e.expiresAt = Date.now() + seconds * 1000; },
  };
}

// In-memory state only survives within one process, so it is for local development only.
export const store = url && token ? redisStore() : (globalThis.__sketchxMemoryStore ??= memoryStore());
