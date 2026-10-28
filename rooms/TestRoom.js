const { Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");

const WORLD = 1000;

class Player extends Schema {}
defineTypes(Player, {
  x: "number",
  y: "number",
  name: "string",
  color: "string",
});

class State extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
defineTypes(State, {
  players: { map: Player },
});

class TestRoom extends Room {
  maxClients = 50;

  onCreate() {
    this.setState(new State());
    this.setPatchRate(50); // 20 state patches per second

    this.onMessage("move", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !msg) return;
      p.x = Math.max(0, Math.min(WORLD, Number(msg.x) || 0));
      p.y = Math.max(0, Math.min(WORLD, Number(msg.y) || 0));
    });

    // echo straight back so the client can measure round-trip time
    this.onMessage("ping", (client, t) => client.send("pong", t));
  }

  onJoin(client) {
    const p = new Player();
    p.x = WORLD / 2;
    p.y = WORLD / 2;
    p.name = "P-" + client.sessionId.slice(0, 4);
    p.color = `hsl(${Math.floor(Math.random() * 360)}, 80%, 60%)`;
    this.state.players.set(client.sessionId, p);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
  }
}

module.exports = { TestRoom };
