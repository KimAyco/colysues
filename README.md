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
