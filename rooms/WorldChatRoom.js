const { Room, ServerError } = require("colyseus");
const { verifyGameToken } = require("./auth");
const { sanitizeName, sanitizeChat, TokenBucket } = require("./validate");

const rooms = new Set();

class WorldChatRoom extends Room {
  maxClients = Number(process.env.WORLD_CHAT_MAX_CLIENTS) || 500;

  onCreate() {
    rooms.add(this);
    this.accounts = new Map();
    this.buckets = new Map();
    this.onMessage("chat", (client, message) => this.handleChat(client, message));
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
    });
    this.buckets.set(client.sessionId, new TokenBucket(1, 2));
  }

  onLeave(client) {
    this.accounts.delete(client.sessionId);
    this.buckets.delete(client.sessionId);
  }

  handleChat(client, payload) {
    if (!payload || typeof payload !== "object") return;
    const account = this.accounts.get(client.sessionId);
    const bucket = this.buckets.get(client.sessionId);
    if (!account || !bucket || !bucket.take()) return;
    const text = sanitizeChat(payload.text);
    if (!text) return;
    const chatMessage = {
      id: client.sessionId,
      name: account.name,
      text,
      at: Date.now(),
    };
    for (const room of rooms) room.broadcast("world-chat", chatMessage);
  }
}

module.exports = { WorldChatRoom };
