// Run with `npm test`. Starts a real server on a free port and connects colyseus.js bots to it.
process.env.FISHING_MAX_CLIENTS = "3"; // small rooms so the overflow test is cheap

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("colyseus.js");
const { createGameServer, parseOrigins } = require("../server");

let server;
let port;
let client;
const open = [];
let codeCounter = 0;
/** Each test gets its own private room so tests do not see each other's players. */
const uniqueCode = () => `T${++codeCounter}`;

before(async () => {
  server = createGameServer({ allowedOrigins: ["*"] });
  port = await server.listen(0);
  client = new Client(`ws://localhost:${port}`);
});

// leave() on a room that already left never resolves in this client, so never wait on it for long
const leaveQuietly = (room) => Promise.race([room.leave().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);

afterEach(async () => {
  await Promise.all(open.splice(0).map(leaveQuietly));
});

after(async () => {
  await server.shutdown();
});

async function join(mapId, options = {}) {
  const room = await client.joinOrCreate("fishing", { mapId, code: uniqueCode(), ...options });
  open.push(room);
  const inbox = { correct: [], chat: [], emote: [], pong: [] };
  for (const k of Object.keys(inbox)) room.onMessage(k, (m) => inbox[k].push(m));
  await waitFor(() => room.state && room.state.players && room.state.players.get(room.sessionId));
  return { room, inbox, me: () => room.state.players.get(room.sessionId) };
}

async function waitFor(fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail("timed out waiting for condition");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (path) => (await fetch(`http://localhost:${port}${path}`)).json();

test("a player sees another player's movement in the same map", async () => {
  const code = uniqueCode();
  const a = await join("pond", { code, name: "Ann", x: 100, y: 100 });
  const b = await join("pond", { code, name: "Bob", x: 200, y: 200 });
  await waitFor(() => b.room.state.players.size === 2 && a.room.state.players.size === 2);

  a.room.send("move", { x: 103, y: 100, dir: "right", moving: true });
  await waitFor(() => {
    const p = b.room.state.players.get(a.room.sessionId);
    return p && Math.abs(p.x - 103) < 0.01 && p.dir === "right" && p.moving === true;
  });
  assert.equal(b.room.state.players.get(a.room.sessionId).name, "Ann");
  await a.room.leave();
  await waitFor(() => b.room.state.players.size === 1);
});

test("players on different maps never see each other", async () => {
  const a = await join("river", { x: 50, y: 50 });
  const b = await join("swamp", { x: 60, y: 60 });
  await sleep(200);
  assert.equal(a.room.state.players.size, 1);
  assert.equal(b.room.state.players.size, 1);
  assert.notEqual(a.room.roomId, b.room.roomId);
});

test("ping is answered with the server clock, and the state carries the shared epoch", async () => {
  const a = await join("river", { x: 50, y: 50 });
  a.room.send("ping", 12345);
  await waitFor(() => a.inbox.pong.length === 1);
  assert.equal(a.inbox.pong[0].t, 12345);
  assert.ok(Math.abs(a.inbox.pong[0].now - Date.now()) < 5000);
  assert.ok(a.room.state.epoch > 0 && a.room.state.epoch <= a.inbox.pong[0].now);
  const b = await join("swamp", { x: 50, y: 50 });
  assert.equal(b.room.state.epoch, a.room.state.epoch, "every room shares one world clock");
});

test("teleporting is rejected and the client is told to go back", async () => {
  const a = await join("swamp", { x: 100, y: 100 });
  a.room.send("move", { x: 900, y: 900, dir: "down", moving: true });
  await waitFor(() => a.inbox.correct.length === 1);
  assert.deepEqual(a.inbox.correct[0], { x: 100, y: 100 });
  assert.equal(a.me().x, 100);
});

test("positions are clamped to the map", async () => {
  const a = await join("swamp", { x: 4, y: 4 });
  a.room.send("move", { x: -3, y: 4, dir: "left", moving: true });
  await waitFor(() => a.me().x === 0);
  assert.equal(a.me().y, 4);
});

test("bad move messages are ignored", async () => {
  const a = await join("swamp", { x: 300, y: 300 });
  for (const bad of [null, "x", { x: "1", y: 2 }, { x: NaN, y: 2 }, { x: Infinity, y: 2 }, { y: 2 }, 5, []]) a.room.send("move", bad);
  await sleep(150);
  assert.equal(a.me().x, 300);
  assert.equal(a.me().y, 300);
});

test("names are sanitized", async () => {
  const a = await join("swamp", { name: "  <b>Evil\u0007Name that is far too long  " });
  assert.ok(a.me().name.length <= 16, a.me().name);
  assert.ok(!/[<>\u0007]/.test(a.me().name), a.me().name);
  const b = await join("swamp", { name: "   " });
  assert.match(b.me().name, /^Angler-/);
});

test("an unknown map or a bad room code is rejected", async () => {
  await assert.rejects(client.joinOrCreate("fishing", { mapId: "moon", code: "" }));
  await assert.rejects(client.joinOrCreate("fishing", { mapId: "pond", code: "no good!" }));
  await assert.rejects(client.joinOrCreate("fishing", {}));
});

test("a join cannot lie its way into an existing room", async () => {
  await join("pond", { code: "" }); // a public pond room now exists
  await assert.rejects(client.joinOrCreate("fishing", {}), "no options must not match the pond room");
  await assert.rejects(client.joinOrCreate("fishing", { code: "" }), "no map must not match the pond room");
});

test("fishing state is shared and validated", async () => {
  const code = uniqueCode();
  const a = await join("swamp", { code, x: 100, y: 100 });
  const b = await join("swamp", { code, x: 100, y: 100 });
  await waitFor(() => b.room.state.players.size >= 2);
  a.room.send("fish", { state: "reeling", bx: 150, by: 140 });
  await waitFor(() => {
    const p = b.room.state.players.get(a.room.sessionId);
    return p && p.state === "reeling" && p.bx === 150 && p.by === 140;
  });
  a.room.send("fish", { state: "teleport-hack", bx: -50, by: 99999 });
  await waitFor(() => b.room.state.players.get(a.room.sessionId).state === "idle");
  assert.equal(b.room.state.players.get(a.room.sessionId).bx, 0);
  assert.ok(b.room.state.players.get(a.room.sessionId).by <= 56 * 16);
});

test("emotes are broadcast and chat is cleaned and rate limited", async () => {
  const code = uniqueCode();
  const a = await join("swamp", { code, name: "Ann" });
  const b = await join("swamp", { code, name: "Bob" });
  await waitFor(() => b.room.state.players.size >= 2);

  a.room.send("emote", { e: 9 }); // out of range, dropped
  await sleep(100);
  assert.equal(b.inbox.emote.length, 0);

  await sleep(1100); // let the chat bucket refill after the emote above
  a.room.send("emote", { e: 2 });
  await waitFor(() => b.inbox.emote.length === 1);
  assert.deepEqual(b.inbox.emote[0], { id: a.room.sessionId, e: 2 });

  await sleep(1100);
  for (let i = 0; i < 6; i++) a.room.send("chat", { text: i === 0 ? "  hi <there>\u0007  " : `spam ${i}` });
  await sleep(300);
  assert.equal(b.inbox.chat[0].text, "hi there");
  assert.equal(b.inbox.chat[0].name, "Ann");
  assert.ok(b.inbox.chat.length >= 1 && b.inbox.chat.length <= 3, `got ${b.inbox.chat.length} chat messages`);
});

test("a full room spills into a second one, and /api/maps counts both", async () => {
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await join("ocean", { code: "", x: 100 + i, y: 100 }));
  const rooms = new Set(players.map((p) => p.room.roomId));
  assert.equal(rooms.size, 2);
  const ocean = (await json("/api/maps")).find((m) => m.id === "ocean");
  assert.deepEqual(ocean, { id: "ocean", players: 4, rooms: 2 });
});

test("room codes make private rooms that are not listed", async () => {
  const a = await join("pond", { code: "FRIENDS", x: 10, y: 10 });
  const b = await join("pond", { code: "FRIENDS", x: 20, y: 20 });
  const c = await join("pond", { code: "OTHER", x: 30, y: 30 });
  await waitFor(() => a.room.state.players.size === 2);
  assert.equal(a.room.roomId, b.room.roomId);
  assert.notEqual(a.room.roomId, c.room.roomId);
  assert.equal(c.room.state.players.size, 1);
  const pond = (await json("/api/maps")).find((m) => m.id === "pond");
  assert.equal(pond.players, 0, "private rooms must not appear in the public counts");
});

test("health endpoint and CORS", async () => {
  const r = await fetch(`http://localhost:${port}/health`, { headers: { Origin: "https://fishgame.vercel.app" } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("with an origin list, only listed origins get CORS headers", async () => {
  // just the Express app: Colyseus' matchmaker is process-wide, so a second Server here would clash
  const http = require("node:http");
  const { createApp } = require("../server");
  const { app } = createApp(parseOrigins("https://fishgame.vercel.app/"));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const p = srv.address().port;
  try {
    const ok = await fetch(`http://localhost:${p}/health`, { headers: { Origin: "https://fishgame.vercel.app" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://fishgame.vercel.app");
    const bad = await fetch(`http://localhost:${p}/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(bad.headers.get("access-control-allow-origin"), null);
    const pre = await fetch(`http://localhost:${p}/api/maps`, { method: "OPTIONS", headers: { Origin: "https://fishgame.vercel.app" } });
    assert.equal(pre.status, 204);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
