// Run with `npm test`. Starts a real server on a free port and connects colyseus.js bots to it.
process.env.FISHING_MAX_CLIENTS = "3"; // small rooms so the overflow test is cheap
process.env.WORLD_CHAT_MAX_CLIENTS = "2"; // prove global chat still spans overflow rooms
process.env.GAME_AUTH_SECRET = "test-game-auth-secret-0123456789-abcdefgh";

const { test, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("colyseus.js");
const { createGameServer, parseOrigins } = require("../server");
const { signGameToken } = require("../rooms/auth");

let server;
let port;
let client;
const open = [];
let codeCounter = 0;
let accountCounter = 0;
const authSecret = process.env.GAME_AUTH_SECRET;
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
  const { name, accountId = ++accountCounter, ...joinOptions } = options;
  const username = name ?? `Player${accountId}`;
  const token = signGameToken(accountId, username, authSecret);
  const room = await client.joinOrCreate("fishing", { mapId, code: uniqueCode(), ...joinOptions, token });
  open.push(room);
  const inbox = { correct: [], chat: [], emote: [], pong: [] };
  for (const k of Object.keys(inbox)) room.onMessage(k, (m) => inbox[k].push(m));
  await waitFor(() => room.state && room.state.players && room.state.players.get(room.sessionId));
  return { room, inbox, token, me: () => room.state.players.get(room.sessionId) };
}

async function joinWorldChat(token) {
  const room = await client.joinOrCreate("world-chat", { token });
  open.push(room);
  const messages = [];
  room.onMessage("world-chat", (message) => messages.push(message));
  return { room, messages };
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

test("fishing rooms require a signed account token", async () => {
  await assert.rejects(client.joinOrCreate("fishing", { mapId: "pond", code: uniqueCode() }));
  await assert.rejects(client.joinOrCreate("fishing", { mapId: "pond", code: uniqueCode(), token: "not-a-token" }));
});

test("world chat reaches players on different maps and sanitizes messages", async () => {
  const angler = await join("pond", { name: "Ann" });
  const other = await join("swamp", { name: "Bob" });
  const third = await join("ocean", { name: "Cleo" });
  const anglerChat = await joinWorldChat(angler.token);
  const otherChat = await joinWorldChat(other.token);
  const thirdChat = await joinWorldChat(third.token);
  assert.notEqual(anglerChat.room.roomId, thirdChat.room.roomId, "capacity overflow creates another chat room");

  anglerChat.room.send("chat", { text: "  hello <world>\u0007  " });
  await waitFor(() => otherChat.messages.length === 1);
  await waitFor(() => thirdChat.messages.length === 1);
  assert.equal(anglerChat.messages.length, 1, "the sender also receives the world message");
  assert.deepEqual(otherChat.messages[0], anglerChat.messages[0]);
  assert.equal(otherChat.messages[0].name, "Ann");
  assert.equal(otherChat.messages[0].text, "hello world");
  assert.equal(otherChat.messages[0].kind, "chat");
  assert.ok(Number.isInteger(otherChat.messages[0].hue));
  assert.ok(Number.isFinite(otherChat.messages[0].at));

  anglerChat.room.send("catch", { fishName: "Bluefin Tuna", rarity: "rare", size: 42.6 });
  await waitFor(() => otherChat.messages.length === 2);
  await waitFor(() => thirdChat.messages.length === 2);
  assert.equal(otherChat.messages[1].name, "Ann");
  assert.equal(otherChat.messages[1].text, "caught a Rare Bluefin Tuna (43 cm)!");
  assert.equal(otherChat.messages[1].kind, "catch");
  assert.equal(otherChat.messages[1].rarity, "rare");
  assert.equal(otherChat.messages[1].hue, otherChat.messages[0].hue);
  assert.equal(thirdChat.messages[1].text, otherChat.messages[1].text);

  otherChat.room.send("chat", { text: "Bob is here" });
  await waitFor(() => anglerChat.messages.length === 3);
  assert.ok(Math.abs(anglerChat.messages[2].hue - anglerChat.messages[0].hue) > 60);
});

test("world chat requires a valid signed account token", async () => {
  await assert.rejects(client.joinOrCreate("world-chat", {}));
  await assert.rejects(client.joinOrCreate("world-chat", { token: "not-a-token" }));
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

test("database health checks the configured PHP API", async () => {
  const http = require("node:http");
  const { createApp } = require("../server");
  let requestedUrl;
  const { app } = createApp(["*"], {
    gameApiUrl: "https://tempdatabase.free.nf/APIdatabase",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return Response.json({ success: true, data: { status: "ok", database: "connected", maps: 16 } });
    },
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, resolve));
  try {
    const response = await fetch(`http://localhost:${srv.address().port}/api/database-health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, database: "connected", maps: 16 });
    assert.equal(requestedUrl, "https://tempdatabase.free.nf/APIdatabase/health.php");
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("game API client solves the host browser check and retries with ?i=1", async () => {
  const crypto = require("node:crypto");
  const { createGameApi } = require("../rooms/gameApi");
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const secret = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(secret), cipher.final()]).toString("hex");
  const page = `<script>var a=toNumbers("${key.toString("hex")}"),b=toNumbers("${iv.toString("hex")}"),c=toNumbers("${enc}");</script>`;
  const seen = [];
  const api = createGameApi({
    baseUrl: "https://example.test/APIdatabase",
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), cookie: init.headers.Cookie });
      return init.headers.Cookie
        ? Response.json({ success: true, data: { status: "ok", database: "connected", maps: 16 } })
        : new Response(page, { headers: { "content-type": "text/html" } });
    },
  });
  assert.equal((await api.health()).maps, 16);
  assert.equal(seen[0].url, "https://example.test/APIdatabase/health.php");
  assert.equal(seen[1].url, "https://example.test/APIdatabase/health.php?i=1");
  assert.equal(seen[1].cookie, `__test=${secret.toString("hex")}`);
  await api.health();
  assert.equal(seen.length, 3, "the solved cookie is reused");
});

test("a POST solves the host browser check with a GET first, and reuses the cookie across clients", async () => {
  const crypto = require("node:crypto");
  const { createGameApi } = require("../rooms/gameApi");
  const key = crypto.randomBytes(16), iv = crypto.randomBytes(16), secret = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(secret), cipher.final()]).toString("hex");
  const page = `<script>var a=toNumbers("${key.toString("hex")}"),b=toNumbers("${iv.toString("hex")}"),c=toNumbers("${enc}");</script>`;
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    if (!init.headers.Cookie) {
      return init.method === "POST"
        ? new Response(null, { status: 302, headers: { location: "/" } })
        : new Response(page, { headers: { "content-type": "text/html" } });
    }
    return Response.json({ success: true, data: { write: "ok", readBack: true, rolledBack: true } });
  };
  const options = { baseUrl: "https://posttest.example/APIdatabase", serviceSecret: "k".repeat(40), fetchImpl };
  assert.equal((await createGameApi(options).writeTest()).write, "ok");
  assert.deepEqual(seen, [
    "GET https://posttest.example/APIdatabase/health.php",
    "POST https://posttest.example/APIdatabase/write_test.php?i=1",
  ]);
  seen.length = 0;
  await createGameApi(options).writeTest(); // a brand-new client reuses the solved cookie
  assert.deepEqual(seen, ["POST https://posttest.example/APIdatabase/write_test.php?i=1"]);
});

test("a redirect from the API host is reported with its destination", async () => {
  const { createGameApi } = require("../rooms/gameApi");
  const api = createGameApi({
    baseUrl: "https://redirect.example/APIdatabase",
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
  });
  await assert.rejects(api.health(), /redirected the request \(HTTP 302 to https:\/\/elsewhere\.example\//);
});

test("the game API proxy relays calls to PHP and only the token and JSON body", async () => {
  const http = require("node:http");
  const { createApp } = require("../server");
  const calls = [];
  const { app } = createApp(["https://fishgame.vercel.app"], {
    gameApiUrl: "https://proxytest.example/APIdatabase",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
      return Response.json({ success: false, error: "Invalid credentials" }, { status: 401 });
    },
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, resolve));
  const base = `http://localhost:${srv.address().port}/api/db`;
  try {
    const login = await fetch(`${base}/auth.php?action=login&i=9`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer abc.def.ghi", "X-Game-Service-Key": "stolen", Origin: "https://fishgame.vercel.app" },
      body: JSON.stringify({ username: "kimayco", password: "password1" }),
    });
    assert.equal(login.status, 401, "the PHP status and JSON are passed through");
    assert.deepEqual(await login.json(), { success: false, error: "Invalid credentials" });
    assert.equal(login.headers.get("access-control-allow-origin"), "https://fishgame.vercel.app");
    const sent = calls.find((c) => c.method === "POST");
    assert.equal(sent.url, "https://proxytest.example/APIdatabase/auth.php?action=login");
    assert.equal(sent.headers.Authorization, "Bearer abc.def.ghi");
    assert.equal(sent.headers["X-Game-Service-Key"], undefined, "a client-supplied service key is never forwarded");
    assert.deepEqual(JSON.parse(sent.body), { username: "kimayco", password: "password1" });

    assert.equal((await fetch(`${base}/write_test.php`, { method: "POST" })).status, 404, "unlisted PHP files are not proxied");
    assert.equal((await fetch(`${base}/db_config.php`)).status, 404);
    const preflight = await fetch(`${base}/game.php`, { method: "OPTIONS", headers: { Origin: "https://fishgame.vercel.app" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /Authorization/);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("database write test calls the PHP self-test with the service key", async () => {
  const http = require("node:http");
  const { createApp } = require("../server");
  process.env.GAME_SERVICE_SECRET = "s".repeat(40);
  let seen;
  const { app } = createApp(["*"], {
    gameApiUrl: "https://writetest.example/APIdatabase",
    fetchImpl: async (url, init) => {
      seen = { url: String(url), method: init.method, key: init.headers["X-Game-Service-Key"] };
      return Response.json({ success: true, data: { write: "ok", readBack: true, rolledBack: true } });
    },
  });
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, resolve));
  try {
    const base = `http://localhost:${srv.address().port}/api/database-write-test`;
    const first = await fetch(base, { method: "POST" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, write: "ok", readBack: true, rolledBack: true });
    assert.equal(seen.url, "https://writetest.example/APIdatabase/write_test.php");
    assert.equal(seen.method, "POST");
    assert.equal(seen.key, "s".repeat(40));
    assert.equal((await fetch(base, { method: "POST" })).status, 429, "rapid repeats are throttled");
  } finally {
    delete process.env.GAME_SERVICE_SECRET;
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("database health reports missing configuration and blocked API responses", async () => {
  const http = require("node:http");
  const { createApp } = require("../server");
  const apps = [
    createApp(["*"]),
    createApp(["*"], {
      gameApiUrl: "https://tempdatabase.free.nf/APIdatabase",
      fetchImpl: async () => new Response("<html>browser check</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    }),
  ];
  const servers = apps.map(({ app }) => http.createServer(app));
  try {
    for (const server of servers) await new Promise((resolve) => server.listen(0, resolve));
    const missing = await fetch(`http://localhost:${servers[0].address().port}/api/database-health`);
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /GAME_API_URL/);

    const blocked = await fetch(`http://localhost:${servers[1].address().port}/api/database-health`);
    assert.equal(blocked.status, 502);
    assert.match((await blocked.json()).error, /non-JSON response/);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
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
