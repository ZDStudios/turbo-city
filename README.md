# Turbo City — 3D Multiplayer Open World Car Simulator

A browser-based, multiplayer open-world driving game built with **Three.js**
(frontend) and **Node.js + Express + Socket.IO** (backend). The frontend is a
single `index.html` you can host for free on **GitHub Pages**; the backend runs
for free on **Render.com**.

```
index.html    → complete frontend (Three.js game + UI + WebSocket client)
server.js     → Node.js backend (lobbies, NPC traffic sim, world sync)
package.json  → backend dependencies + start script
render.yaml   → Render.com blueprint
```

---

## 1. Run locally (quick start)

You need [Node.js 18+](https://nodejs.org).

```bash
# from this folder
npm install
npm start          # backend now listening on http://localhost:3000
```

Then open the frontend. The simplest way is any static server, e.g.:

```bash
# option A: VS Code "Live Server" extension — right-click index.html → Open with Live Server
# option B: a one-liner static server
npx serve .        # serves index.html (note the URL it prints, e.g. http://localhost:3000)
```

`index.html` auto-detects `localhost` and connects to `http://localhost:3000`,
so local play works out of the box. Open the page in **two browser tabs** to
test multiplayer — create a lobby in one, copy the join code, and join from the
other (or use **Join Public Server** after creating a public lobby).

> Browsers block audio until you interact with the page — click once and the
> engine sound starts.

---

## 2. Deploy the backend to Render.com (free tier)

1. Push this whole folder to a **GitHub repository**.
2. Go to [render.com](https://render.com) → **New +** → **Blueprint**.
3. Select your repo. Render reads `render.yaml` and creates a free **web
   service** that runs `npm install` then `node server.js`.
4. Wait for the deploy to finish. Your backend URL will look like:
   `https://car-simulator-server.onrender.com`
5. Verify it's up by visiting `https://<your-service>.onrender.com/health` —
   you should see `{ "status": "ok", ... }`.

> **Free-tier note:** Render free services spin down after ~15 min of
> inactivity and take ~30–60s to wake on the next request. The first connection
> after idle may be slow — that's normal.

### Lock down CORS (recommended after frontend is live)
In the Render dashboard → your service → **Environment**, set:
- `STRICT_CORS = true`
- `ALLOWED_ORIGINS = https://<your-username>.github.io`

(You can list multiple origins comma-separated.) Redeploy.

---

## 3. Deploy the frontend to GitHub Pages

1. In the same (or a separate) GitHub repo containing `index.html`:
   **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. Choose branch `main` and folder `/ (root)`. Save.
3. After ~1 minute your game is live at:
   `https://<your-username>.github.io/<repo-name>/`

---

## 4. Point the frontend at your backend

Open `index.html` and find the **CONFIG** block near the top of the `<script type="module">`:

```js
const CONFIG = {
  SERVER_URL: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://your-render-app.onrender.com',   // ← CHANGE THIS
  INPUT_HZ: 60,
};
```

Replace `https://your-render-app.onrender.com` with your real Render URL from
step 2. Commit and push — GitHub Pages redeploys automatically.

---

## 5. How to play & invite friends

1. Open the GitHub Pages URL.
2. Enter a **driver name**.
3. **CREATE LOBBY** → you get a 6-character **JOIN CODE**. Share it with friends.
   - Or **CREATE PUBLIC LOBBY** so anyone can find it under **JOIN PUBLIC SERVER**.
4. Friends click **JOIN WITH CODE**, type your code, and land in the lobby.
5. In the lobby: pick a **car** + **color**, tick **Ready**. The **host** sets
   max players / traffic / time of day / weather and presses **START GAME**.
6. Drive!

### Controls
| Key | Action |
| --- | --- |
| `W` / `↑` | Accelerate |
| `S` / `↓` | Brake / Reverse |
| `A` / `←` | Steer left |
| `D` / `→` | Steer right |
| `SPACE` | Handbrake (drift) |
| `SHIFT` | Nitro boost |
| `H` | Horn |
| `ENTER` | Chat |
| `ESC` | Pause menu |
| Right-click + drag | Free-look camera orbit |
| Mouse wheel | Zoom camera |

### Features
- 6 cars (Sports, Muscle, SUV, Pickup, Supercar, Sedan) with distinct stats &
  geometry, 10 chassis colors.
- Procedural open-world city: road grid, buildings, parks/trees, elevated
  highway loop, tunnel, ramps, glowing boost pads.
- Day/night cycle, weather (clear/rain/fog), shadows, fog, gradient sky.
- Drift physics, suspension/body-roll, skid marks, smoke & exhaust particles,
  speed lines, car damage, oscillator-based engine sound.
- Server-simulated NPC traffic + pedestrians synced to all players.
- HUD: speedometer, minimap, gear, nitro bar, damage, clock, chat, ping,
  floating name tags.

---

## Architecture notes
- **Physics** runs client-side for the local player and is sent to the server
  at ~60 Hz. The server lightly validates/clamps it and rebroadcasts all player
  states at ~20 Hz; clients interpolate remote cars to hide latency.
- **NPCs** are fully server-authoritative (20 Hz waypoint simulation) and
  broadcast per lobby room — every client sees the same traffic.
- The client world builder and the server NPC paths share the same grid
  constants (`blocks`, `spacing`), so cars line up on the roads.

## Troubleshooting
- **"Disconnected — check CONFIG.SERVER_URL"** on the menu: the frontend can't
  reach the backend. Confirm the Render service is awake (`/health`) and that
  `CONFIG.SERVER_URL` is correct.
- **CORS errors in console:** add your exact GitHub Pages origin to
  `ALLOWED_ORIGINS` on Render, or set `STRICT_CORS=false` while testing.
- **First join is slow:** Render free tier cold start — give it a minute.
