You are a senior full-stack game developer. Build me a complete, 
fully working 3D multiplayer open world car simulator game split 
into two parts:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARCHITECTURE OVERVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FRONTEND:
- A single self-contained index.html file (with all CSS and JS inline 
  or via CDN imports) that is deployable directly to GitHub Pages.
- Uses Three.js (via CDN) for 3D rendering.
- Uses a WebSocket client to connect to the backend server.

BACKEND:
- A Node.js server using Express + Socket.IO (WebSockets).
- Designed to run for FREE on Render.com (render.com free tier).
- Handles: player connections, lobby management, join codes, 
  NPC state, world sync, and physics authority.
- Provide a render.yaml or clear Render deployment instructions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRONTEND — GAME FEATURES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RENDERING (Three.js):
- Full 3D open world map with roads, grass, buildings, trees, 
  bridges, tunnels, a highway loop, and city blocks. Use 
  procedural geometry and BoxGeometry/CylinderGeometry etc. 
  since no asset server is available.
- Day/night cycle with directional lighting and ambient light shift.
- Shadows enabled (PCFSoftShadowMap).
- Fog for atmosphere (THREE.Fog).
- Skybox using a gradient or CubeCamera.
- Reflective car paint using MeshStandardMaterial with envMap.
- Headlights (SpotLight attached to each car) that activate at night.

CAMERA SYSTEM:
- Default: smooth 3rd-person follow camera sitting behind and 
  above the car.
- RIGHT CLICK + DRAG: allows the player to orbit the camera 
  a full 360 degrees horizontally and roughly 90 degrees 
  vertically around the car (like GTA/Forza free look). 
  Camera snaps back smoothly when right click is released.
- Mouse wheel: zoom in/out on the car (clamped min/max distance).
- The car always drives in the direction the camera is facing 
  (just like GTA V) when W is pressed.

CAR PHYSICS (client-side with server reconciliation):
- Realistic feeling car physics using a simplified but satisfying 
  model: acceleration, braking, friction, wheel grip, drift on 
  high-speed turns, suspension bounce.
- Cars have: speed, steering angle, wheel rotation animation, 
  body roll on turns, suspension compression on bumps.
- Collision detection with world objects and other players/NPCs.
- Handbrake (SPACE) causes rear wheel drift.

CONTROLS:
- W / Up Arrow — Accelerate
- S / Down Arrow — Brake / Reverse
- A / Left Arrow — Steer left
- D / Right Arrow — Steer right
- SPACE — Handbrake (drift)
- SHIFT — Nitro boost (with cooldown, visual exhaust effect)
- H — Horn (plays a sound or shows chat bubble)
- Right Click + Drag — Free look camera orbit (full 360°)
- Scroll Wheel — Zoom camera
- ESC — Open pause / lobby menu

CAR SELECTION:
Offer at least 6 distinct car types the player picks before 
entering a lobby:
1. Sports Car — fast, low grip, sleek
2. Muscle Car — high torque, rear wheel drift, chunky
3. SUV — tall, slower, high suspension travel
4. Pickup Truck — wide, sturdy, slight body roll
5. Supercar — top speed king, low body, aggressive
6. Classic Sedan — balanced, everyday feel

Each car has:
- Unique geometry built from Three.js primitives (box/cylinder 
  combos) with distinct proportions and color options.
- Different stat values: TopSpeed, Acceleration, Handling, 
  BrakeForce, Mass.
- A chassis color picker (at least 10 color options) on the 
  car select screen.

NPC TRAFFIC:
- At least 15 NPC vehicles driving on roads following waypoint 
  paths on a loop.
- NPCs have simple AI: follow path, slow near other vehicles, 
  stop at intersections, occasional random lane change.
- NPC cars honk (visual bubble) if the player cuts them off.
- Pedestrian NPCs walking on sidewalks with basic path following.
- NPCs are simulated server-side and synced to all clients.

HUD / UI (rendered in HTML/CSS overlay on top of the canvas):
- Speedometer (analog arc style) bottom-right.
- Mini-map (top-right) showing the world overhead, player dot, 
  NPC dots, other players.
- Current gear indicator.
- Nitro bar with cooldown indicator.
- Player name tag floating above each other player's car in 3D space.
- Lap timer / free roam clock (top center).
- Chat box (bottom left) — players can type messages.
- Ping indicator (top-left).
- Car damage indicator (simple body panel color changes on HUD).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOBBY SYSTEM & MULTIPLAYER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MAIN MENU (shown before game starts):
- Game title header.
- Player name input field.
- "CREATE LOBBY" button — creates a private lobby and shows 
  a 6-character alphanumeric JOIN CODE the host can share.
- "JOIN WITH CODE" button + text input — joins a friend's lobby 
  using their join code.
- "JOIN PUBLIC SERVER" button — browser shows a list of active 
  public lobbies with: lobby name, player count, max players, 
  host name, and a JOIN button.
- Car selection screen appears after choosing a lobby.

LOBBY WAITING ROOM:
- Shows connected players list with their chosen car and color.
- Host can set: Max Players (2–16), World Size, Traffic Density, 
  Time of Day.
- Host has a "START GAME" button; others see "Waiting for host...".
- Live player join/leave notifications.
- A ready-up checkbox for each player.
- Lobby chat.

IN-GAME MULTIPLAYER:
- All players appear in the same 3D world in real-time.
- Player positions, rotations, speeds interpolated smoothly 
  (client-side interpolation to hide latency).
- Player name tags visible above cars.
- Players can see each other's headlights, brake lights 
  (red glow when braking), and indicator signals.
- If a player disconnects, their car fades out gracefully.
- Server broadcasts NPC positions to all clients at ~20 Hz.
- Player inputs sent to server at ~60 Hz, server validates 
  and rebroadcasts at ~20 Hz.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BACKEND — SERVER (Node.js / Render.com)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

File: server.js (or index.js)
Dependencies: express, socket.io, cors, uuid

ENDPOINTS:
- GET /health — returns { status: "ok" } for Render health checks.
- GET /lobbies — returns list of public lobbies (JSON).

SOCKET EVENTS (server handles):
- "createLobby" — creates lobby, generates join code, returns it.
- "joinLobby" — joins by code or public lobby ID.
- "playerReady" — marks player ready.
- "startGame" — host starts the game, emits "gameStart" to lobby.
- "playerInput" — receives player input state, validates, 
  rebroadcasts as "playerUpdate".
- "chatMessage" — broadcasts to lobby room.
- "disconnect" — removes player, notifies room.

NPC SIMULATION (server-side):
- Server runs a game loop at 20 Hz.
- Maintains NPC positions along waypoints.
- Broadcasts "npcUpdate" with all NPC positions to each lobby room.

CORS:
- Allow requests from your GitHub Pages domain 
  (https://[yourusername].github.io) and localhost for dev.

RENDER DEPLOYMENT:
- Include a render.yaml with:
    - service type: web
    - runtime: node
    - build command: npm install
    - start command: node server.js
    - free tier instance type
- Include a package.json with all deps and a "start" script.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GITHUB PAGES DEPLOYMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- The entire frontend is ONE index.html file.
- At the top of the JS section include a CONFIG block:
    const CONFIG = {
      SERVER_URL: "https://your-render-app.onrender.com",
      // Change this to your Render URL after deploying
    };
- Include clear comments at the top of index.html explaining 
  exactly how to deploy to GitHub Pages (just push to a repo 
  and enable Pages in settings).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
POLISH & FUN DETAILS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Tire skid marks (decal lines on the road surface when drifting).
- Dust/smoke particle effect when drifting or accelerating hard 
  (simple Three.js Points geometry).
- Exhaust particle emitter on each car.
- Car damage system: hitting objects at speed changes the car's 
  body color zones to show dents (no model deformation needed, 
  just color panel darkening on a damage map).
- Speed lines post-processing effect at high speed 
  (CSS radial blur overlay or Three.js shader).
- Collectible boost pads on the road (glowing yellow chevrons) 
  that give a 3-second nitro boost.
- Ramps and stunt areas on the map (jumps, loops).
- Random weather toggle: clear, rain (particle rain + wet road 
  shininess), fog (THREE.Fog density increase).
- Ambient city sounds described as what would play (comment them 
  in code) — use the Web Audio API for engine pitch tied to speed 
  (oscillator-based engine sound that rises with RPM).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Deliver the following files in full, no truncation, no 
"// ... rest of code here" shortcuts — every line written out:

1. index.html — complete frontend (Three.js game + UI + 
   WebSocket client) ready for GitHub Pages.
2. server.js — complete Node.js backend for Render.com.
3. package.json — with all dependencies and scripts.
4. render.yaml — Render.com deployment config.
5. README.md — step-by-step setup instructions:
   a. How to deploy the backend to Render.com (free tier).
   b. How to deploy the frontend to GitHub Pages.
   c. How to update CONFIG.SERVER_URL in index.html.
   d. How to play and share a join code with friends.

Write clean, well-commented code. Prioritize it working 
correctly over being short. The game must be genuinely fun 
to drive and look impressive visually given the constraints 
of a browser + Three.js + free server.