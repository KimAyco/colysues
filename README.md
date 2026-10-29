# Colyseus latency / location broadcast test

Minimal Colyseus 0.16 server plus a browser client that measures round-trip latency
(ping/pong over the room socket) and shows every connected player's position live.

## Run locally
    npm install
    npm start
Open http://localhost:2567 in several tabs.

## Deploy on Render (free)
1. Push this repo to GitHub.
2. New > Blueprint (uses `render.yaml`), or New > Web Service with root dir `colysues`,
   build `npm install`, start `npm start`, health check `/health`.
3. Open the `onrender.com` URL on two or more devices.

## Things to expect on the free tier
- The service sleeps after ~15 min idle; the first request takes ~30-60 s (cold start).
- Single shared-CPU instance: watch jitter and p95 as you add players or enable the bot on many tabs.
- Choose the Render region closest to you; RTT is dominated by distance.

## Stress test
Simulates N players moving at a fixed rate and reports latency, patch rate, failures and server load
(the server exposes CPU, memory and event-loop lag at `/stats`).

    npm install
    node stress.js --url https://<your-service>.onrender.com --players 50 --rate 20 --duration 60

Options: `--players` (20), `--rate` moves/s per player (20), `--duration` hold seconds (30),
`--ramp` players joined per second (10), `--ping` ping interval ms (1000), `--url` (http://localhost:2567).

Columns: `rtt_*` ping/pong round trip, `patch/s/bot` state updates each bot receives (server target is ~30),
`lost` pings with no reply after 5 s, `srv_cpu%` server CPU (100 = one full core; the free tier is a fraction of a core),
`loop_p99ms` event-loop lag on the server. Rising RTT and loop lag with falling patch/s means the server is saturated.
Run it from your own machine to include real network distance, and note the stress bots share one machine's connection.


---

# Pixel Fishing: realtime player API

The `"fishing"` room is the multiplayer server for the Pixel Fishing game
(`github.com/KimAyco/fishgame`). Players in the same map see each other walk, fish, emote and chat.
The old `"game"` room above is untouched, so the latency page and `stress.js` still work.

The game is hosted on Vercel and this server on Render. Vercel cannot hold WebSocket connections,
so the browser connects here directly over `wss://`.

## Connecting

```js
import { Client } from "colyseus.js"; // 0.16
const client = new Client("wss://<your-service>.onrender.com");
const room = await client.joinOrCreate("fishing", {
  mapId: "pond",          // required: pond | river | ocean | swamp
  code: "",               // "" = the public room of that map; "ABC123" = a private friends' room
  name: "Ann",            // optional, cleaned to 16 chars; default "Angler-xxxx"
  x: 100, y: 100,         // optional start position in world pixels (default: centre of the map)
});
```

One room exists per `(mapId, code)`. A room holds 24 players (`FISHING_MAX_CLIENTS`); when it is full
the next player gets a second room for the same map. Rooms with a `code` are private: they are not
listed in `/api/maps`. A code is 0 to 12 characters of `A-Z0-9`.

Joining with a missing or wrong `mapId` or an invalid `code` fails with error code `4000` (unknown or wrong
map) or `4001` (bad or wrong room code).

## State (synchronised automatically, 20 patches per second)

`room.state.epoch`: when the shared world clock started (ms since the Unix epoch). Day and night
and weather in the game are derived from the time since this, so every player sees the same hour.

`room.state.players`: a map from session id to:

| field    | type    | meaning                                                                       |
| -------- | ------- | ----------------------------------------------------------------------------- |
| `x`, `y` | number  | feet position in world pixels                                                 |
| `dir`    | string  | `up` `down` `left` `right`                                                    |
| `moving` | boolean | walking (for the walk animation)                                              |
| `name`   | string  | display name                                                                  |
| `hue`    | number  | 0 to 359, a stable colour for this player                                     |
| `state`  | string  | `idle` `charging` `casting` `waiting` `bite` `reeling`                        |
| `bx`,`by`| number  | position of the fishing float while `state` is not `idle`                     |

## Messages

Client to server (about 40 messages a second are allowed per player; the rest are dropped):

| message | payload                                  | notes                                                                                   |
| ------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `move`  | `{ x, y, dir, moving }`                  | clamped to the map. Faster than about 1.6x walking speed is rejected (see `correct`).   |
| `fish`  | `{ state, bx, by }`                      | unknown states become `idle`; the float is clamped to the map.                           |
| `emote` | `{ e }`                                  | `e` is an integer 0 to 3. Broadcast to the room.                                        |
| `chat`  | `{ text }`                               | cleaned (no control characters or `<` `>`), 80 chars. About 1 per second.               |
| `ping`  | any number (send `Date.now()`)           | answered with `pong`.                                                                    |

Server to client:

| message   | payload                          | notes                                                                              |
| --------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `pong`    | `{ t, now }`                     | `t` is your ping value, `now` is the server clock in ms. Use it to align clocks.   |
| `correct` | `{ x, y }`                       | your `move` was too fast; put the player back here.                                |
| `emote`   | `{ id, e }`                      | `id` is the sender's session id (including you).                                   |
| `chat`    | `{ id, name, text }`             | already cleaned.                                                                    |

Positions are client-authoritative (the game does its own collision), checked only for bounds and speed.
Inventory, coins and catches are not synchronised: they stay in each player's own save.

A player who loses their connection stays in the world for 6 seconds (`allowReconnection`) so a short
network blip does not drop them; `client.reconnect(room.reconnectionToken)` takes the same seat back.

## HTTP endpoints

| endpoint        | returns                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /health`   | `{ ok: true, uptime }`. Used by Render's health check and by the game to wake a sleeping server.                |
| `GET /api/maps` | `[{ id, players, rooms }]`: live counts per map across public rooms. Private (code) rooms are not counted.      |
| `GET /stats`    | server load for the stress tester (see above).                                                                  |

## Settings (environment variables)

| variable               | default | meaning                                                                                       |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `PORT`                 | 2567    | port to listen on (Render sets this).                                                         |
| `ALLOWED_ORIGINS`      | `*`     | comma-separated browser origins allowed to call the HTTP API and matchmaking, e.g. `https://fishgame.vercel.app`. Set it in production. |
| `FISHING_MAX_CLIENTS`  | 24      | players per `"fishing"` room.                                                                 |
| `MAX_CLIENTS`          | 200     | players per `"game"` (latency test) room.                                                     |

## Tests

    npm test

Starts a real server on a free port and connects `colyseus.js` bots: movement between players, map
isolation, anti-teleport and clamping, name and chat cleaning, rate limits, room overflow, room codes,
`/api/maps`, CORS, and joins that try to lie their way into a room.

## Deploying

1. Push this repo to GitHub (`KimAyco/colysues`). Render redeploys from `render.yaml`.
2. In the Render service's Environment tab set `ALLOWED_ORIGINS` to your game's URL (the Vercel domain).
3. Give the game that server: in the Vercel project settings set `VITE_COLYSEUS_URL=wss://<your-service>.onrender.com`
   and redeploy the game. It must be `wss://` because the game is served over https.

Keep the map sizes in `rooms/maps.js` in step with `src/data/maps.ts` in the game repo whenever a map changes size.
