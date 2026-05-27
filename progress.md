# 3D Multiplayer Car Simulator — Build Progress

Tracking implementation of the game described in `prompt.md`.

## Files delivered
- [x] `index.html` — complete Three.js frontend + UI + WebSocket client
- [x] `server.js` — Node.js backend (Express + Socket.IO)
- [x] `package.json` — deps + scripts
- [x] `render.yaml` — Render.com deploy config
- [x] `README.md` — setup/deploy instructions

## Backend (server.js) — DONE
- [x] Express app + HTTP server + Socket.IO
- [x] CORS for GitHub Pages + localhost (STRICT_CORS toggle)
- [x] GET /health endpoint
- [x] GET /lobbies endpoint (public lobby list)
- [x] Lobby manager: create, 6-char join code, public join, max players, host reassign
- [x] Socket events: createLobby, joinLobby, selectCar, lobbySettings, playerReady,
      startGame, playerInput, chatMessage, leaveLobby, disconnect, rtt (ping)
- [x] Player input validation + clamping + rebroadcast as playerUpdate (~20Hz)
- [x] NPC simulation loop @ 20Hz (waypoint vehicles + pedestrians, slow/honk AI)
- [x] Broadcast npcUpdate per lobby room

## Frontend (index.html) — DONE
- [x] CONFIG block with SERVER_URL (auto localhost vs prod)
- [x] Three.js scene, renderer, PCFSoftShadowMap, fog, gradient sky shader
- [x] Procedural world: road grid, grass, buildings (lit windows), trees/parks,
      elevated highway loop + pillars, ramp, tunnel, city blocks
- [x] Day/night cycle (directional + ambient + hemi shift, night car/window lights)
- [x] 6 car types with distinct geometry + stats
- [x] Car color picker (10 colors)
- [x] Physics: accel, brake, reverse, friction, grip, drift, handbrake slide,
      suspension/jump, body roll, pitch
- [x] Controls: WASD/arrows, SPACE handbrake, SHIFT nitro, H horn, ESC pause, ENTER chat
- [x] Camera: 3rd-person follow, right-click orbit, scroll zoom, auto-center (GTA aim)
- [x] Headlights (SpotLight) at night, brake lights glow
- [x] Collision detection (building AABBs + NPC/player spheres + world bounds)
- [x] HUD: speedometer arc, minimap, gear, nitro bar, name tags, clock, chat, ping, damage
- [x] Main menu: title, name, create/join-code/public lobby list
- [x] Lobby room: player list, car/color select, host settings, ready-up, start, chat
- [x] Multiplayer sync + interpolation, fade-out on disconnect
- [x] Polish: skid marks, drift smoke, exhaust, damage darkening, speed lines,
      boost pads (+3s nitro), ramps, rain/fog weather, Web Audio engine + horn

## Verification
- [x] `npm install` succeeds (91 packages)
- [x] `node -c server.js` syntax OK
- [x] Server boots, /health + /lobbies respond
- [x] Socket flow test passed: createLobby, gameStart (18 NPCs/12 peds),
      playerInput -> playerUpdate, npcUpdate all received
- [x] index.html brace/script-tag balance check passes
- [ ] Browser run NOT performed in this environment (no headless browser).
      Manual test: serve index.html, open two tabs, create + join by code.

## Offline mode (added 2026-05-27)
- [x] "PLAY OFFLINE (Solo)" button on main menu — no server needed
- [x] Opens a solo lobby (code "SOLO") reusing car/color select + settings UI
- [x] Client-side NPC + pedestrian sim mirrors the server's waypoint logic
- [x] START runs the game fully locally; HUD ping shows "OFFLINE"
- [x] Leave/quit/back-to-lobby reset offline state and stop the local sim
- [x] Module script passes `node --check`

## Notes / Decisions
- Single self-contained `index.html`: Three.js via ESM importmap (unpkg r0.160),
  Socket.IO client via CDN global `io`.
- Physics client-side with server rebroadcast (authoritative-lite); NPCs server-authoritative.
- Car selection lives inside the lobby waiting room (satisfies "after choosing a lobby").
- Client world grid constants (blocks=6, spacing=90) match server so NPCs align to roads.
