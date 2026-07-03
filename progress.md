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

## Batch 2 (2026-05-27) — collisions, physics, multiplayer
- [x] Server-authoritative collisions: NPCs get knocked/launched when rammed (knockVx/vz/vy + spin, broadcast with y)
- [x] Player-vs-player collision impulses emitted to both clients ('collision' event, per-pair cooldown)
- [x] Client: collision radius 4.2 (no more phasing), softer stop, ram launches/flips, applies server impulses
- [x] Air control: A/D roll, W/S pitch, yaw while airborne for clean landings
- [x] Building roofs are solid — land on top & drive off; gravity drops you safely (no death)
- [x] Change car mid-game via pause -> GARAGE (rebuilds live mesh, syncs to others)
- [x] Max players raised to 32
- [x] Persistent "🌍 Official Open World" public server (always started, survives empty, code PUBLIC)
- [x] Fixed: can now JOIN a public game already in progress (late-joiner gets gameStart + spawn)
- [x] Player Y clamp raised server-side for building tops / future flight

## Batch 3 (2026-05-27) — race, airplane, shop, random maps, admin
- [x] Race mode: host picks "Race" in lobby; 3-lap checkpoint circuit, 5s countdown,
      live positions (server-ranked), results screen, coin rewards (1st=400…). Works solo offline too.
- [x] Airplane vehicle: W/S throttle, A/D bank-turn, SPACE climb; take off, fly over the city, land.
- [x] Currency + upgrades: earn coins driving/ramming/racing; SHOP (menu + pause) buys
      Top Speed/Accel/Handling/Brakes/Nitro (5 levels each). Saved in localStorage; applies to all cars.
- [x] Random maps: server sends a mapSeed each game; clients build the SAME seeded layout
      (buildings/parks/trees/ramps/boost pads vary; road grid stays fixed so NPCs align). Offline gets a fresh seed.
- [x] Admin/cheats: host enables "Cheats" in lobby settings -> ADMIN PANEL in pause.
      Per-player: Kick, Trap, Free, Fly, Heal, Boost, Bring-to-me, and Control (puppet via input relay).

## Verified (server, automated socket test)
- race lobby start -> gameStart carries seed + 8 checkpoints + 3 laps + mode
- raceProgress(finished) -> raceFinished (place + reward) + live raceStandings
- adminCommand trap relayed to target; kick removes target ('kicked')
- client module + server both syntax-clean

## Caveat: "always online" public server
- The persistent 🌍 Official Open World lobby is created on server boot and survives empty.
- BUT Render free tier sleeps the whole process after ~15 min idle -> in-memory state resets and
  first request after idle is slow. True 24/7 needs a paid instance or an external keep-alive pinger.

## Batch 4 (2026-05-28) — combat: health + turret
- [x] Fixed: remote players' mesh now rebuilds when they change vehicle/colour (planes no longer show as cars)
- [x] Health system: 100 HP, HUD bar, slow regen after 4s, destroy -> explosion -> respawn (full heal)
- [x] Turret: buy once in shop (🪙1500); fire with F / left-click; networked tracers everyone sees
- [x] Hits reduce target health (server relays fire/hitPlayer->damaged); kill feed + 🪙150 per kill
- [x] Remote players show a name-tag health bar + turret barrel if equipped
- [x] Offline: turret shots knock NPCs around
- [x] Verified via socket test: fire relay, damaged, killFeed, hp/turret in playerUpdate

## Batch 5 (2026-05-28) — server-side admin code
- [x] "🔐 Admin Login" on the home menu: enter a code, server validates it (code is in server.js
      only — never shipped to the browser, so it can't be inspected). Code: 6741 (override w/ ADMIN_CODE env).
- [x] Correct code -> super-admin for the session: ADMIN PANEL works in ANY lobby (bypasses host/cheats),
      infinite coins (∞ shown, all shop items + turret free), manage everyone in the lobby.
- [x] superAdmins tracked server-side per socket; adminCommand/controlInput honor it; cleared on disconnect.
- [x] Verified: wrong code rejected, 6741 accepted, admin command works on the public server with cheats OFF.

## Deploy reminder (unchanged)
- Server changes require REDEPLOYING server.js to Render.
- Client changes require pushing index.html to GitHub Pages.
- The admin code 6741 lives in server.js (on Render) — players only ever download index.html, so it stays hidden.

## Deploy reminder
- Server changes (collisions, persistent lobby, 32 players, join-in-progress) require REDEPLOYING server.js to Render.
- Client changes require pushing index.html to GitHub Pages.

## Notes / Decisions
- Single self-contained `index.html`: Three.js via ESM importmap (unpkg r0.160),
  Socket.IO client via CDN global `io`.
- Physics client-side with server rebroadcast (authoritative-lite); NPCs server-authoritative.
- Car selection lives inside the lobby waiting room (satisfies "after choosing a lobby").
- Client world grid constants (blocks=6, spacing=90) match server so NPCs align to roads.
