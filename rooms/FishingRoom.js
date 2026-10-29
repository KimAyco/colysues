const { Room, ServerError } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");
const { isMapId, mapBounds } = require("./maps");
const { DIRS, FISH_STATES, EMOTES, num, clamp, sanitizeName, sanitizeChat, isValidCode, hueFromId, TokenBucket } = require("./validate");

/** Walking speed of the game client, in world pixels per second. */
const WALK_SPEED = 62;
/** How much faster than WALK_SPEED a player may appear to move before the move is rejected. */
const SPEED_TOLERANCE = 1.6;

/** How long a player who lost their connection stays in the world, waiting to come back. */
const RECONNECT_SECONDS = 6;

/** One shared world clock for every room: day/night and weather are derived from time since this. */
const SERVER_EPOCH = Date.now();

class Player extends Schema {}
defineTypes(Player, {
  x: "number",
  y: "number",
  dir: "string",
  moving: "boolean",
  name: "string",
  hue: "number",
  state: "string",
  bx: "number",
  by: "number",
});

class State extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.epoch = SERVER_EPOCH;
  }
}
defineTypes(State, { players: { map: Player }, epoch: "number" });

/**
 * One room per (map, code). Players are client-authoritative for where they stand (the game
 * does its own collision) but every update is bounds- and speed-checked here.
 *
 * Join options: { mapId, code?, name?, x?, y? }
 * Client -> server messages: move, fish, emote, chat, ping
 * Server -> client messages: pong ({ t, now }), correct ({ x, y }), emote, chat
 * State: players (by session id) and `epoch`, the instant the shared world clock started.
 */
class FishingRoom extends Room {
  maxClients = Number(process.env.FISHING_MAX_CLIENTS) || 24;

  onCreate(options) {
    const mapId = options && options.mapId;
    const code = options && options.code === undefined ? "" : options.code;
    if (!isMapId(mapId)) throw new ServerError(4000, "unknown map");
    if (!isValidCode(code)) throw new ServerError(4001, "invalid room code");

    this.mapId = mapId;
    this.code = code;
    this.bounds = mapBounds(mapId);
    this.buckets = new Map(); // sessionId -> { msg, chat }
    this.lastMove = new Map(); // sessionId -> ms of the last accepted move

    this.setMetadata({ mapId, code });
    this.setState(new State());
    this.setPatchRate(50); // 20 state patches per second

    this.onMessage("move", (client, msg) => this.handleMove(client, msg));
    this.onMessage("fish", (client, msg) => this.handleFish(client, msg));
    this.onMessage("emote", (client, msg) => this.handleEmote(client, msg));
    this.onMessage("chat", (client, msg) => this.handleChat(client, msg));
    // the reply also carries the server clock, so a client can work out its offset to it
    this.onMessage("ping", (client, t) => client.send("pong", { t: num(t), now: Date.now() }));
  }

  /**
   * `filterBy` treats a missing option as "match any room", so a join that omits or lies about
   * the map or code could land in a room it did not ask for. Check the options against this room.
   */
  onAuth(client, options) {
    const o = options || {};
    const code = o.code === undefined ? "" : o.code;
    if (o.mapId !== this.mapId) throw new ServerError(4000, "wrong map");
    if (code !== this.code) throw new ServerError(4001, "wrong room code");
    return true;
  }

  onJoin(client, options) {
    const o = options || {};
    const p = new Player();
    p.x = clamp(num(o.x) ?? this.bounds.w / 2, 0, this.bounds.w);
    p.y = clamp(num(o.y) ?? this.bounds.h / 2, 0, this.bounds.h);
    p.dir = "down";
    p.moving = false;
    p.name = sanitizeName(o.name, "Angler-" + client.sessionId.slice(0, 4));
    p.hue = hueFromId(client.sessionId);
    p.state = "idle";
    p.bx = p.x;
    p.by = p.y;
    this.state.players.set(client.sessionId, p);
    this.buckets.set(client.sessionId, { msg: new TokenBucket(40, 60), chat: new TokenBucket(1, 2) });
    this.lastMove.set(client.sessionId, Date.now());
  }

  async onLeave(client, consented) {
    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_SECONDS); // a short network blip should not drop the player
        return;
      } catch {
        // did not come back
      }
    }
    this.removePlayer(client.sessionId);
  }

  removePlayer(id) {
    this.state.players.delete(id);
    this.buckets.delete(id);
    this.lastMove.delete(id);
  }

  allow(client, bucket = "msg") {
    const b = this.buckets.get(client.sessionId);
    return !!b && b[bucket].take();
  }

  handleMove(client, msg) {
    if (!this.allow(client) || !msg || typeof msg !== "object") return;
    const p = this.state.players.get(client.sessionId);
    const x = num(msg.x);
    const y = num(msg.y);
    if (!p || x === null || y === null) return;

    const now = Date.now();
    const dt = clamp(now - (this.lastMove.get(client.sessionId) ?? now), 16, 5000);
    const limit = (WALK_SPEED * SPEED_TOLERANCE * dt) / 1000 + 8;
    const nx = clamp(x, 0, this.bounds.w);
    const ny = clamp(y, 0, this.bounds.h);
    if (Math.hypot(nx - p.x, ny - p.y) > limit) {
      client.send("correct", { x: p.x, y: p.y }); // too fast to be walking: put the client back
      return;
    }
    this.lastMove.set(client.sessionId, now);
    p.x = nx;
    p.y = ny;
    if (DIRS.has(msg.dir)) p.dir = msg.dir;
    p.moving = msg.moving === true;
  }

  handleFish(client, msg) {
    if (!this.allow(client) || !msg || typeof msg !== "object") return;
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.state = FISH_STATES.has(msg.state) ? msg.state : "idle";
    const bx = num(msg.bx);
    const by = num(msg.by);
    if (bx !== null) p.bx = clamp(bx, 0, this.bounds.w);
    if (by !== null) p.by = clamp(by, 0, this.bounds.h);
  }

  handleEmote(client, msg) {
    if (!this.allow(client) || !this.allow(client, "chat") || !msg) return;
    const e = num(msg.e);
    if (e === null || !Number.isInteger(e) || e < 0 || e >= EMOTES) return;
    this.broadcast("emote", { id: client.sessionId, e });
  }

  handleChat(client, msg) {
    if (!msg || typeof msg !== "object" || !this.allow(client) || !this.allow(client, "chat")) return;
    const text = sanitizeChat(msg.text);
    const p = this.state.players.get(client.sessionId);
    if (!text || !p) return;
    this.broadcast("chat", { id: client.sessionId, name: p.name, text });
  }
}

module.exports = { FishingRoom, SERVER_EPOCH, WALK_SPEED, SPEED_TOLERANCE };
