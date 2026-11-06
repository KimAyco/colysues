const http = require("http");
const path = require("path");
const express = require("express");
const { Server, matchMaker } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { monitorEventLoopDelay } = require("perf_hooks");
const { TestRoom, stats } = require("./rooms/TestRoom");
const { FishingRoom } = require("./rooms/FishingRoom");
const { MAPS } = require("./rooms/maps");

/**
 * Comma-separated origins allowed to call the HTTP API and matchmaking from a browser,
 * e.g. ALLOWED_ORIGINS=https://fishgame.vercel.app. Unset or `*` allows any origin (fine for dev).
 */
function parseOrigins(value) {
  return String(value || "*")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function createApp(allowedOrigins, { gameApiUrl = process.env.GAME_API_URL, fetchImpl = fetch } = {}) {
  const app = express();
  const anyOrigin = allowedOrigins.includes("*");
  const corsOrigin = (origin) => (anyOrigin ? "*" : origin && allowedOrigins.includes(origin) ? origin : null);

  app.use((req, res, next) => {
    const allow = corsOrigin(req.headers.origin);
    if (allow) {
      res.setHeader("Access-Control-Allow-Origin", allow);
      if (allow !== "*") res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.get("/api/database-health", async (_req, res) => {
    if (!gameApiUrl) {
      return res.status(503).json({ ok: false, error: "GAME_API_URL is not configured on the Colyseus server." });
    }

    let healthUrl;
    try {
      const baseUrl = new URL(gameApiUrl);
      if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
        throw new Error("invalid API URL");
      }
      healthUrl = new URL("health.php", `${baseUrl.href.replace(/\/+$/, "")}/`);
    } catch {
      return res.status(503).json({ ok: false, error: "GAME_API_URL must be a valid HTTP(S) URL to the PHP API folder." });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(healthUrl, { signal: controller.signal, headers: { Accept: "application/json" } });
      let payload;
      try {
        payload = await response.json();
      } catch {
        const error = `The PHP API returned a non-JSON response (HTTP ${response.status}). The host may be showing a browser check or blocking server requests.`;
        console.error("[database-check]", error);
        return res.status(502).json({ ok: false, error });
      }

      if (!response.ok || payload?.status !== "ok" || payload?.database !== "connected") {
        const error = typeof payload?.error === "string"
          ? payload.error
          : `The PHP API or database check failed (HTTP ${response.status}).`;
        return res.status(503).json({ ok: false, error });
      }
      return res.json({ ok: true, database: "connected", maps: Number(payload.maps) || 0 });
    } catch (error) {
      const timedOut = error && error.name === "AbortError";
      const message = timedOut
        ? "The PHP API database check timed out after 8 seconds."
        : "The Colyseus server could not reach the PHP API. Check its URL and hosting restrictions.";
      console.error("[database-check]", message, error);
      return res.status(502).json({ ok: false, error: message });
    } finally {
      clearTimeout(timeout);
    }
  });

  // server load snapshot for the stress tester; each call reports the window since the previous call
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = process.hrtime.bigint();
  app.get("/stats", (_req, res) => {
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(lastCpu);
    const wallUs = Number(now - lastAt) / 1000;
    lastCpu = process.cpuUsage();
    lastAt = now;
    const mem = process.memoryUsage();
    res.json({
      ccu: stats.ccu,
      rooms: stats.rooms,
      cpuPercent: wallUs ? ((cpu.user + cpu.system) / wallUs) * 100 : 0,
      rssMB: mem.rss / 1048576,
      heapMB: mem.heapUsed / 1048576,
      // the histogram includes its own 10 ms sampling interval, so subtract it to get real lag
      loopLagP99Ms: Math.max(0, loop.percentile(99) / 1e6 - 10),
      loopLagMaxMs: Math.max(0, loop.max / 1e6 - 10),
    });
    loop.reset();
  });

  // live player counts per map, public rooms only (private friend-code rooms are not listed)
  app.get("/api/maps", async (_req, res) => {
    try {
      const out = Object.fromEntries(Object.keys(MAPS).map((id) => [id, { id, players: 0, rooms: 0 }]));
      for (const room of await matchMaker.query({ name: "fishing" })) {
        const meta = room.metadata || {};
        if (meta.code || !out[meta.mapId]) continue;
        out[meta.mapId].players += room.clients;
        out[meta.mapId].rooms += 1;
      }
      res.json(Object.values(out));
    } catch (e) {
      res.status(500).json({ error: String(e && e.message) });
    }
  });

  app.use(express.static(path.join(__dirname, "public")));
  return { app, corsOrigin };
}

/** Builds the server. `listen(port)` resolves once it accepts connections; port 0 picks a free one. */
function createGameServer({ allowedOrigins = parseOrigins(process.env.ALLOWED_ORIGINS) } = {}) {
  const { app, corsOrigin } = createApp(allowedOrigins);
  const httpServer = http.createServer(app);
  const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });

  // matchmaking (POST /matchmake/...) is answered by Colyseus itself, so apply the same origin rule there
  matchMaker.controller.getCorsHeaders = (req) => {
    const allow = corsOrigin(req.headers.origin);
    return allow ? { "Access-Control-Allow-Origin": allow } : { "Access-Control-Allow-Origin": "null" };
  };

  gameServer.define("game", TestRoom); // latency / stress test room (public/index.html, stress.js)
  gameServer.define("fishing", FishingRoom).filterBy(["mapId", "code"]);

  return {
    gameServer,
    httpServer,
    async listen(port) {
      await gameServer.listen(port);
      return httpServer.address().port;
    },
    shutdown: () => gameServer.gracefullyShutdown(false),
  };
}

module.exports = { createGameServer, createApp, parseOrigins };

if (require.main === module) {
  const port = Number(process.env.PORT) || 2567;
  createGameServer()
    .listen(port)
    .then((p) => console.log(`Listening on http://localhost:${p}`));
}
