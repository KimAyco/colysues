const http = require("http");
const path = require("path");
const express = require("express");
const { Server, matchMaker } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { monitorEventLoopDelay } = require("perf_hooks");
const { TestRoom, stats } = require("./rooms/TestRoom");
const { FishingRoom } = require("./rooms/FishingRoom");
const { WorldChatRoom } = require("./rooms/WorldChatRoom");
const { MAPS } = require("./rooms/maps");
const { createGameApi } = require("./rooms/gameApi");

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
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Browser -> Colyseus -> PHP. A browser cannot pass a free host's JavaScript browser check on a
  // cross-origin request, but this server can, so the game's account/save calls go through here.
  // Only the bearer token and JSON body are relayed; the game-service key never leaves this server.
  const PROXIED = new Set(["auth.php", "game.php", "maps.php", "health.php"]);
  const jsonBody = express.json({ limit: "64kb" });
  app.all("/api/db/:file", jsonBody, async (req, res) => {
    const file = req.params.file;
    if (!PROXIED.has(file)) return res.status(404).json({ success: false, error: "Unknown API endpoint" });
    if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ success: false, error: "Method not allowed" });

    const query = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (key !== "i" && typeof value === "string") query[key] = value;
    }
    const headers = {};
    if (typeof req.headers.authorization === "string") headers.Authorization = req.headers.authorization;
    const hasBody = req.method === "POST";

    try {
      const api = createGameApi({ baseUrl: gameApiUrl, fetchImpl });
      const { status, payload } = await api.forward(file, { method: req.method, query, headers, body: hasBody ? req.body ?? {} : undefined });
      res.setHeader("Cache-Control", "no-store");
      return res.status(status).json(payload);
    } catch (error) {
      console.error("[api-proxy]", file, error.message);
      return res.status(502).json({ success: false, error: "The game database is unreachable right now." });
    }
  });

  app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.get("/api/database-health", async (_req, res) => {
    const api = createGameApi({ baseUrl: gameApiUrl, fetchImpl });
    try {
      const data = await api.health();
      if (data?.status !== "ok" || data?.database !== "connected") {
        return res.status(503).json({ ok: false, error: "The PHP API reported that the database is not connected." });
      }
      return res.json({ ok: true, database: "connected", maps: Number(data.maps) || 0 });
    } catch (error) {
      console.error("[database-check]", error.message);
      const status = !gameApiUrl || /GAME_API_URL/.test(error.message) ? 503 : error.status >= 400 && !error.blocked ? 503 : 502;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  // Proves the PHP API can write to MySQL. The PHP side rolls the test row back, but the route still
  // costs a database round trip, so it is throttled and a failed run never reveals secrets.
  let lastWriteTest = 0;
  app.post("/api/database-write-test", async (_req, res) => {
    const now = Date.now();
    if (now - lastWriteTest < 5000) {
      return res.status(429).json({ ok: false, error: "Wait a few seconds before running the write test again." });
    }
    lastWriteTest = now;
    const api = createGameApi({ baseUrl: gameApiUrl, fetchImpl });
    try {
      const data = await api.writeTest();
      if (data?.write !== "ok" || data?.readBack !== true) {
        return res.status(503).json({ ok: false, error: "The PHP API did not confirm the database write." });
      }
      return res.json({ ok: true, write: "ok", readBack: true, rolledBack: data.rolledBack === true });
    } catch (error) {
      console.error("[database-write-test]", error.message);
      const status = /GAME_(API_URL|SERVICE_SECRET)/.test(error.message) ? 503 : error.blocked || !error.status ? 502 : 503;
      return res.status(status).json({ ok: false, error: error.message });
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
  gameServer.define("world-chat", WorldChatRoom);

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
