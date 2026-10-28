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
