const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { TestRoom } = require("./rooms/TestRoom");

const port = Number(process.env.PORT) || 2567;

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("game", TestRoom);

gameServer.listen(port).then(() => {
  console.log(`Listening on http://localhost:${port}`);
});
