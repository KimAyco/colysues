const crypto = require("node:crypto");

/**
 * Client for the PHP/MySQL game API (APIdatabase/).
 *
 * Free hosts such as InfinityFree answer clients that are not browsers with an HTML "browser
 * check" page holding an AES-encrypted token. A browser decrypts it into a `__test` cookie and
 * reloads the URL with `?i=1`. This client does the same, so the Colyseus server can talk to the
 * API without being blocked. The solved cookie is cached and reused.
 *
 * The API replies with { success: true, data } or { success: false, error }.
 */

const CHALLENGE = /toNumbers\("([0-9a-f]+)"\)\s*,\s*b\s*=\s*toNumbers\("([0-9a-f]+)"\)\s*,\s*c\s*=\s*toNumbers\("([0-9a-f]+)"\)/i;
const USER_AGENT = "Mozilla/5.0 (compatible; PixelFishingServer/1.0)";

class GameApiError extends Error {
  constructor(message, { status = 0, blocked = false } = {}) {
    super(message);
    this.name = "GameApiError";
    this.status = status;
    this.blocked = blocked;
  }
}

/** Returns the `__test` cookie value for a challenge page, or null if `html` is not one. */
function solveChallenge(html) {
  const m = CHALLENGE.exec(html);
  if (!m) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(m[1], "hex"), Buffer.from(m[2], "hex"));
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(Buffer.from(m[3], "hex")), decipher.final()]).toString("hex");
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GameApiError("GAME_API_URL must be a valid HTTP(S) URL to the PHP API folder.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new GameApiError("GAME_API_URL must be a valid HTTP(S) URL to the PHP API folder.");
  }
  return `${url.href.replace(/\/+$/, "")}/`;
}

function createGameApi({
  baseUrl = process.env.GAME_API_URL,
  serviceSecret = process.env.GAME_SERVICE_SECRET,
  fetchImpl = fetch,
  timeoutMs = 8000,
} = {}) {
  let hostCookie = null;

  async function send(url, init) {
    const headers = { Accept: "application/json", "User-Agent": USER_AGENT, ...init.headers };
    if (hostCookie) headers.Cookie = `__test=${hostCookie}`;
    const response = await fetchImpl(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { response, text: await response.text() };
  }

  async function request(endpoint, { method = "GET", query = {}, headers = {}, body } = {}) {
    if (!baseUrl) throw new GameApiError("GAME_API_URL is not configured on the Colyseus server.");
    const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const init = {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    let result;
    try {
      result = await send(url, init);
      const cookie = solveChallenge(result.text);
      if (cookie) {
        hostCookie = cookie;
        url.searchParams.set("i", "1");
        result = await send(url, init);
      }
    } catch (error) {
      if (error instanceof GameApiError) throw error;
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new GameApiError(
        timedOut
          ? `The PHP API timed out after ${Math.round(timeoutMs / 1000)} seconds.`
          : "The Colyseus server could not reach the PHP API. Check its URL and hosting restrictions.",
      );
    }

    const { response, text } = result;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new GameApiError(
        `The PHP API returned a non-JSON response (HTTP ${response.status}). The host may be showing a browser check or blocking server requests.`,
        { status: response.status, blocked: true },
      );
    }
    if (!response.ok || payload?.success !== true) {
      throw new GameApiError(typeof payload?.error === "string" ? payload.error : `The PHP API request failed (HTTP ${response.status}).`, {
        status: response.status,
      });
    }
    return payload.data;
  }

  return {
    /** { status: "ok", database: "connected", maps } */
    health: () => request("health.php"),

    /** Inserts a throwaway row, reads it back and rolls back. { write: "ok", readBack, rolledBack } */
    writeTest() {
      if (typeof serviceSecret !== "string" || serviceSecret.length < 32) {
        throw new GameApiError("GAME_SERVICE_SECRET must be configured with at least 32 characters.");
      }
      return request("write_test.php", { method: "POST", headers: { "X-Game-Service-Key": serviceSecret }, body: {} });
    },

    /** Trusted server-only catch write; needs GAME_SERVICE_SECRET to match the PHP host. */
    recordCatch({ accountId, fishId, mapId, zoneId, size, quality }) {
      if (typeof serviceSecret !== "string" || serviceSecret.length < 32) {
        throw new GameApiError("GAME_SERVICE_SECRET must be configured with at least 32 characters.");
      }
      return request("game.php", {
        method: "POST",
        query: { action: "record-catch" },
        headers: { "X-Game-Service-Key": serviceSecret },
        body: { accountId, fishId, mapId, zoneId, size, quality },
      });
    },
  };
}

module.exports = { createGameApi, solveChallenge, GameApiError };
