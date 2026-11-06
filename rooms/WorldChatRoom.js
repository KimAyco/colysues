const { Room, ServerError } = require("colyseus");
const { verifyGameToken } = require("./auth");
const { sanitizeName, sanitizeChat, hueFromId, TokenBucket } = require("./validate");

const rooms = new Set();

class WorldChatRoom extends Room {
  maxClients = Number(process.env.WORLD_CHAT_MAX_CLIENTS) || 500;

  onCreate() {
    rooms.add(this);
    this.accounts = new Map();
    this.buckets = new Map();
    this.catchBuckets = new Map();
    this.onMessage("chat", (client, message) => this.handleChat(client, message));
    this.onMessage("catch", (client, message) => this.handleCatch(client, message));
  }

  onDispose() {
    rooms.delete(this);
  }

  onAuth(_client, options) {
    return verifyGameToken(options && options.token, process.env.GAME_AUTH_SECRET);
  }

  onJoin(client, _options, auth) {
    if (!auth || !Number.isSafeInteger(auth.accountId)) throw new ServerError(4002, "authentication required");
    this.accounts.set(client.sessionId, {
      name: sanitizeName(auth.username, "Angler-" + client.sessionId.slice(0, 4)),
      hue: hueFromId(String(auth.accountId)),
    });
    this.buckets.set(client.sessionId, new TokenBucket(1, 2));
    this.catchBuckets.set(client.sessionId, new TokenBucket(0.5, 2));
  }

  onLeave(client) {
    this.accounts.delete(client.sessionId);
    this.buckets.delete(client.sessionId);
    this.catchBuckets.delete(client.sessionId);
  }

  handleChat(client, payload) {
    if (!payload || typeof payload !== "object") return;
    const account = this.accounts.get(client.sessionId);
    const bucket = this.buckets.get(client.sessionId);
    if (!account || !bucket || !bucket.take()) return;
    const text = sanitizeChat(payload.text);
    if (!text) return;
    this.broadcastWorldMessage({
      id: client.sessionId,
      name: account.name,
      hue: account.hue,
      kind: "chat",
      text,
      at: Date.now(),
    });
  }

  handleCatch(client, payload) {
    if (!payload || typeof payload !== "object") return;
    const account = this.accounts.get(client.sessionId);
    const bucket = this.catchBuckets.get(client.sessionId);
    const fishName = sanitizeChat(payload.fishName).slice(0, 48);
    if (!account || !bucket || !fishName || !bucket.take()) return;
    const size = Number.isFinite(payload.size) && payload.size > 0 && payload.size <= 1000
      ? ` (${Math.round(payload.size)} cm)`
      : "";
    this.broadcastWorldMessage({
      id: client.sessionId,
      name: account.name,
      hue: account.hue,
      kind: "catch",
      text: `caught a ${fishName}${size}!`,
      at: Date.now(),
    });
  }

  broadcastWorldMessage(message) {
    for (const room of rooms) room.broadcast("world-chat", message);
  }
}

module.exports = { WorldChatRoom };
