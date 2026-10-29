// Input validation for messages and join options. Nothing here trusts the client.

const DIRS = new Set(["up", "down", "left", "right"]);
const FISH_STATES = new Set(["idle", "charging", "casting", "waiting", "bite", "reeling"]);
const EMOTES = 4;

/** A finite number, or null. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// C0/C1 control characters, zero-width and bidi marks, line/paragraph separators, and angle brackets.
// Built from code points so the source has no raw control characters in it.
const CONTROL = new RegExp(
  "[" + [[0, 31], [127, 159], [0x200b, 0x200f], [0x2028, 0x202e]].map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "<>]",
  "g"
);

/** Display name: no control characters or angle brackets, collapsed spaces, at most 16 chars. */
function sanitizeName(raw, fallback) {
  const s = (typeof raw === "string" ? raw : "").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return s || fallback;
}

/** Chat text: same cleaning, at most 80 chars. Empty string means "drop it". */
function sanitizeChat(raw) {
  return (typeof raw === "string" ? raw : "").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Room code for private friend rooms: empty (public) or up to 12 letters/digits. */
const isValidCode = (c) => typeof c === "string" && /^[A-Z0-9]{0,12}$/.test(c);

/** Stable colour for a session, 0..359. */
function hueFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Token bucket: `rate` tokens per second, burst of `burst`. */
class TokenBucket {
  constructor(rate, burst, now = Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  take(cost = 1, now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

module.exports = { DIRS, FISH_STATES, EMOTES, num, clamp, sanitizeName, sanitizeChat, isValidCode, hueFromId, TokenBucket };
