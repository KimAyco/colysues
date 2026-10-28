const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { monitorEventLoopDelay } = require("perf_hooks");
const { TestRoom, stats } = require("./rooms/TestRoom");

const port = Number(process.env.PORT) || 2567;

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
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
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("game", TestRoom);

gameServer.listen(port).then(() => {
  console.log(`Listening on http://localhost:${port}`);
});
