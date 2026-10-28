// Colyseus stress tester: spawns N bots that move at a fixed rate and measures
// latency (ping/pong RTT), state patch rate, failures, and server load via /stats.
//
//   node stress.js --url https://colysues.onrender.com --players 50 --rate 20 --duration 60
const { Client } = require("colyseus.js");

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] ?? true;
}
if (args.help) {
  console.log(`Options:
  --url       server url (default http://localhost:2567)
  --players   number of simulated players (default 20)
  --rate      move messages per second per player (default 20)
  --duration  seconds to hold after all players joined (default 30)
  --ramp      players joined per second (default 10)
  --ping      ping interval per player in ms (default 1000)`);
  process.exit(0);
}

const URL_ = String(args.url || "http://localhost:2567").replace(/\/$/, "");
const N = Number(args.players) || 20;
const RATE = Number(args.rate) || 20;
const DURATION = Number(args.duration) || 30;
const RAMP = Number(args.ramp) || 10;
const PING_MS = Number(args.ping) || 1000;
const WORLD = 1000;

const wsUrl = URL_.replace(/^http/, "ws");
const bots = [];
let joinFailures = 0, disconnects = 0, lostPings = 0, movesSent = 0, patches = 0;
const joinTimes = [], allRtts = [];
let sampleRtts = [];

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const max = arr => (arr.length ? arr.reduce((m, v) => (v > m ? v : m), -Infinity) : NaN);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "-");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function spawnBot() {
  const t0 = performance.now();
  let room;
  try {
    room = await new Client(wsUrl).joinOrCreate("game");
  } catch {
    joinFailures++;
    return;
  }
  joinTimes.push(performance.now() - t0);
  const bot = {
    room, alive: true, pending: new Map(),
    x: Math.random() * WORLD, y: Math.random() * WORLD,
    vx: (Math.random() - 0.5) * 300, vy: (Math.random() - 0.5) * 300,
  };
  bots.push(bot);

  room.onMessage("pong", t => {
    if (!bot.pending.delete(t)) return;
    const rtt = performance.now() - t;
    sampleRtts.push(rtt);
    allRtts.push(rtt);
  });
  room.onStateChange(() => { patches++; });
  room.onLeave(() => { if (bot.alive) { bot.alive = false; disconnects++; } });
  room.onError(() => {});

  let last = performance.now();
  bot.moveTimer = setInterval(() => {
    const now = performance.now(), dt = (now - last) / 1000; last = now;
    bot.x += bot.vx * dt; bot.y += bot.vy * dt;
    if (bot.x < 0 || bot.x > WORLD) { bot.vx *= -1; bot.x = Math.max(0, Math.min(WORLD, bot.x)); }
    if (bot.y < 0 || bot.y > WORLD) { bot.vy *= -1; bot.y = Math.max(0, Math.min(WORLD, bot.y)); }
    try { room.send("move", { x: bot.x, y: bot.y }); movesSent++; } catch {}
  }, 1000 / RATE);
  bot.pingTimer = setInterval(() => {
    const t = performance.now();
    for (const k of bot.pending.keys()) if (t - k > 5000) { bot.pending.delete(k); lostPings++; }
    bot.pending.set(t, true);
    try { room.send("ping", t); } catch {}
  }, PING_MS);
}

async function serverStats() {
  try {
    const r = await fetch(URL_ + "/stats", { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return null; }
}

(async () => {
  console.log(`Target ${URL_} | ${N} players x ${RATE} moves/s = ${N * RATE} msgs/s | ramp ${RAMP}/s | hold ${DURATION}s\n`);
  console.log("time  bots  rtt_p50  rtt_p95  rtt_max  patch/s/bot  lost  srv_cpu%  srv_rss  loop_p99ms");
  await serverStats(); // reset the server's measurement window

  const start = performance.now();
  let tick = 0, spawned = 0;

  const reporter = setInterval(async () => {
    const rtts = sampleRtts; sampleRtts = [];
    const p = patches; patches = 0;
    const alive = bots.filter(b => b.alive).length;
    const s = await serverStats();
    tick++;
    console.log(
      `${String(tick).padStart(4)}s ${String(alive).padStart(5)} ${f(pct(rtts, 0.5)).padStart(8)} ${f(pct(rtts, 0.95)).padStart(8)} ` +
      `${f(max(rtts)).padStart(8)} ${f(alive ? p / alive : 0).padStart(12)} ${String(lostPings).padStart(5)} ` +
      `${(s ? f(s.cpuPercent, 0) : "n/a").padStart(9)} ${(s ? f(s.rssMB, 0) + "MB" : "n/a").padStart(8)} ` +
      `${(s ? f(s.loopLagP99Ms) : "n/a").padStart(11)}`
    );
  }, 1000);

  while (spawned < N) {
    const batch = Math.min(RAMP, N - spawned);
    await Promise.all(Array.from({ length: batch }, spawnBot));
    spawned += batch;
    if (spawned < N) await sleep(1000);
  }
  await sleep(DURATION * 1000);

  clearInterval(reporter);
  const total = (performance.now() - start) / 1000;
  const final = await serverStats();
  for (const b of bots) {
    clearInterval(b.moveTimer); clearInterval(b.pingTimer);
    b.alive = false;
    try { b.room.leave(); } catch {}
  }

  console.log("\n=== Summary ===");
  console.log(`Players requested / joined : ${N} / ${bots.length}  (join failures ${joinFailures}, unexpected disconnects ${disconnects})`);
  console.log(`Join time p50 / p95        : ${f(pct(joinTimes, 0.5), 0)} / ${f(pct(joinTimes, 0.95), 0)} ms`);
  console.log(`RTT p50 / p95 / p99 / max  : ${f(pct(allRtts, 0.5))} / ${f(pct(allRtts, 0.95))} / ${f(pct(allRtts, 0.99))} / ${f(max(allRtts))} ms`);
  console.log(`Pings lost (>5s)           : ${lostPings}`);
  console.log(`Moves sent                 : ${movesSent} (~${f(movesSent / total, 0)}/s average)`);
  if (final) console.log(`Server at end              : ccu ${final.ccu}, rooms ${final.rooms}, rss ${f(final.rssMB, 0)}MB, heap ${f(final.heapMB, 0)}MB`);
  setTimeout(() => process.exit(0), 500);
})();
