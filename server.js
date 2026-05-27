/* =====================================================================
   3D Multiplayer Open World Car Simulator — BACKEND
   ---------------------------------------------------------------------
   Node.js + Express + Socket.IO authoritative-lite game server.

   Responsibilities:
     - Player connections + lobby management (private join codes + public)
     - Relay & light validation of player inputs (rebroadcast @ ~20 Hz)
     - Server-side NPC traffic + pedestrian simulation @ 20 Hz
     - World sync to every client in a lobby room

   Designed to run on Render.com free tier:
     - build:  npm install
     - start:  node server.js
     - listens on process.env.PORT
   ===================================================================== */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

// Allowed origins. Add your GitHub Pages URL here (or set ALLOWED_ORIGINS
// env var as a comma-separated list). "*" is accepted as a wildcard for
// quick testing but you should lock this down for production.
const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'https://your-username.github.io', // <-- change to your GitHub Pages domain
];
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  : DEFAULT_ORIGINS;

// During development it's convenient to allow everything. Set
// STRICT_CORS=true on Render to enforce the allow-list.
const STRICT_CORS = process.env.STRICT_CORS === 'true';

const corsOptions = {
  origin: STRICT_CORS ? ALLOWED_ORIGINS : true,
  methods: ['GET', 'POST'],
  credentials: true,
};

// ---------------------------------------------------------------------
// Express + Socket.IO setup
// ---------------------------------------------------------------------
const app = express();
app.use(cors(corsOptions));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
  pingInterval: 10000,
  pingTimeout: 20000,
});

// ---------------------------------------------------------------------
// World definition (MUST stay in sync with the client's world builder)
// The world is a square grid city. Roads run along every grid line.
// ---------------------------------------------------------------------
const WORLD = {
  blocks: 6,        // number of city blocks per side
  spacing: 90,      // distance between road center-lines
  get half() { return (this.blocks * this.spacing) / 2; },
  // road line coordinate for grid index i (0..blocks)
  line(i) { return -this.half + i * this.spacing; },
};

// ---------------------------------------------------------------------
// In-memory lobby store
// ---------------------------------------------------------------------
/**
 * lobby = {
 *   id, code, name, hostId, isPublic,
 *   maxPlayers, worldSize, trafficDensity, timeOfDay, weather,
 *   started,
 *   players: Map<socketId, player>,
 *   npcs: [...], peds: [...],
 *   loopHandle
 * }
 * player = { id, name, carType, color, ready, isHost, state }
 */
const lobbies = new Map();      // lobbyId -> lobby
const codeToLobby = new Map();  // joinCode -> lobbyId
const socketToLobby = new Map();// socketId -> lobbyId

function genJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (codeToLobby.has(code));
  return code;
}

function publicLobbyList() {
  const list = [];
  for (const lobby of lobbies.values()) {
    if (!lobby.isPublic) continue;
    const host = lobby.players.get(lobby.hostId);
    list.push({
      id: lobby.id,
      name: lobby.name,
      code: lobby.code,
      players: lobby.players.size,
      maxPlayers: lobby.maxPlayers,
      hostName: host ? host.name : 'Unknown',
      started: lobby.started,
    });
  }
  return list;
}

function lobbyPlayersPayload(lobby) {
  const arr = [];
  for (const p of lobby.players.values()) {
    arr.push({
      id: p.id,
      name: p.name,
      carType: p.carType,
      color: p.color,
      ready: p.ready,
      isHost: p.id === lobby.hostId,
    });
  }
  return arr;
}

function lobbyMetaPayload(lobby) {
  return {
    id: lobby.id,
    code: lobby.code,
    name: lobby.name,
    hostId: lobby.hostId,
    isPublic: lobby.isPublic,
    maxPlayers: lobby.maxPlayers,
    worldSize: lobby.worldSize,
    trafficDensity: lobby.trafficDensity,
    timeOfDay: lobby.timeOfDay,
    weather: lobby.weather,
    started: lobby.started,
    players: lobbyPlayersPayload(lobby),
  };
}

// ---------------------------------------------------------------------
// NPC simulation
// ---------------------------------------------------------------------
// Build a set of rectangular loop paths along the road grid. NPC cars
// follow these waypoint loops; pedestrians walk shorter sidewalk loops.

function buildNpcPaths() {
  const paths = [];
  const b = WORLD.blocks;
  // Perimeter loop + a few inner rectangular loops between grid lines.
  const rects = [
    [0, 0, b, b],
    [1, 1, b - 1, b - 1],
    [0, 1, b - 1, b],
    [1, 0, b, b - 1],
  ];
  for (const [i0, j0, i1, j1] of rects) {
    const x0 = WORLD.line(i0), z0 = WORLD.line(j0);
    const x1 = WORLD.line(i1), z1 = WORLD.line(j1);
    // clockwise loop of 4 corner waypoints (lane offset for right-hand drive feel)
    const o = 3.5;
    paths.push([
      { x: x0 + o, z: z0 + o },
      { x: x1 - o, z: z0 + o },
      { x: x1 - o, z: z1 - o },
      { x: x0 + o, z: z1 - o },
    ]);
  }
  return paths;
}

const NPC_PATHS = buildNpcPaths();

function spawnNpcs(lobby) {
  const density = lobby.trafficDensity || 'medium';
  const count = density === 'low' ? 10 : density === 'high' ? 28 : 18;
  const npcs = [];
  const colors = [0x3366cc, 0xcc3333, 0x33aa55, 0xddaa22, 0x9933cc, 0x444444, 0xdddddd];
  for (let i = 0; i < count; i++) {
    const path = NPC_PATHS[i % NPC_PATHS.length];
    const seg = Math.floor(Math.random() * path.length);
    const a = path[seg];
    const bpt = path[(seg + 1) % path.length];
    const t = Math.random();
    npcs.push({
      id: 'npc_' + i,
      path: i % NPC_PATHS.length,
      seg,
      t,
      x: a.x + (bpt.x - a.x) * t,
      z: a.z + (bpt.z - a.z) * t,
      heading: Math.atan2(bpt.x - a.x, bpt.z - a.z),
      speed: 0,
      maxSpeed: 16 + Math.random() * 10,
      color: colors[i % colors.length],
      honk: 0,
      stopped: false,
    });
  }
  return npcs;
}

function spawnPedestrians(lobby) {
  const count = 12;
  const peds = [];
  for (let i = 0; i < count; i++) {
    // pedestrians loop a small rectangle near a random block corner
    const gi = 1 + Math.floor(Math.random() * (WORLD.blocks - 1));
    const gj = 1 + Math.floor(Math.random() * (WORLD.blocks - 1));
    const cx = WORLD.line(gi);
    const cz = WORLD.line(gj);
    const r = 8;
    const loop = [
      { x: cx - r, z: cz - r },
      { x: cx + r, z: cz - r },
      { x: cx + r, z: cz + r },
      { x: cx - r, z: cz + r },
    ];
    peds.push({
      id: 'ped_' + i,
      loop,
      seg: Math.floor(Math.random() * 4),
      t: Math.random(),
      x: cx,
      z: cz,
      heading: 0,
      speed: 1.4 + Math.random() * 0.8,
    });
  }
  return peds;
}

const TICK_HZ = 20;
const DT = 1 / TICK_HZ;

function dist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

function stepNpcs(lobby) {
  const npcs = lobby.npcs;
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    const path = NPC_PATHS[n.path];
    const target = path[(n.seg + 1) % path.length];

    // --- simple AI: slow down if a vehicle is close ahead ---
    let slow = false;
    // check other NPCs
    for (let j = 0; j < npcs.length; j++) {
      if (j === i) continue;
      const o = npcs[j];
      const aheadX = n.x + Math.sin(n.heading) * 6;
      const aheadZ = n.z + Math.cos(n.heading) * 6;
      if (dist2(aheadX, aheadZ, o.x, o.z) < 36) { slow = true; break; }
    }
    // check players (cut-off => honk)
    for (const p of lobby.players.values()) {
      if (!p.state) continue;
      const aheadX = n.x + Math.sin(n.heading) * 7;
      const aheadZ = n.z + Math.cos(n.heading) * 7;
      const d2 = dist2(aheadX, aheadZ, p.state.x, p.state.z);
      if (d2 < 49) { slow = true; if (d2 < 25) n.honk = 1.0; }
    }

    // intersection slow-down (near a grid crossing)
    const nearLineX = Math.abs((((n.x + WORLD.half) % WORLD.spacing) + WORLD.spacing) % WORLD.spacing) < 6;
    const nearLineZ = Math.abs((((n.z + WORLD.half) % WORLD.spacing) + WORLD.spacing) % WORLD.spacing) < 6;
    if (nearLineX && nearLineZ) slow = slow || Math.random() < 0.02;

    const desired = slow ? n.maxSpeed * 0.25 : n.maxSpeed;
    // accelerate / brake toward desired
    if (n.speed < desired) n.speed = Math.min(desired, n.speed + 18 * DT);
    else n.speed = Math.max(desired, n.speed - 26 * DT);
    n.stopped = n.speed < 0.5;

    // steer toward target waypoint
    const targetHeading = Math.atan2(target.x - n.x, target.z - n.z);
    let dh = targetHeading - n.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    n.heading += Math.max(-2.5 * DT, Math.min(2.5 * DT, dh));

    // move
    n.x += Math.sin(n.heading) * n.speed * DT;
    n.z += Math.cos(n.heading) * n.speed * DT;

    // reached waypoint?
    if (dist2(n.x, n.z, target.x, target.z) < 16) {
      n.seg = (n.seg + 1) % path.length;
    }

    if (n.honk > 0) n.honk = Math.max(0, n.honk - DT);
  }
}

function stepPedestrians(lobby) {
  for (const p of lobby.peds) {
    const target = p.loop[(p.seg + 1) % p.loop.length];
    const h = Math.atan2(target.x - p.x, target.z - p.z);
    p.heading = h;
    p.x += Math.sin(h) * p.speed * DT;
    p.z += Math.cos(h) * p.speed * DT;
    if (dist2(p.x, p.z, target.x, target.z) < 1.5) {
      p.seg = (p.seg + 1) % p.loop.length;
    }
  }
}

function npcPayload(lobby) {
  return {
    npcs: lobby.npcs.map((n) => ({
      id: n.id,
      x: +n.x.toFixed(2),
      z: +n.z.toFixed(2),
      h: +n.heading.toFixed(3),
      s: +n.speed.toFixed(1),
      c: n.color,
      honk: n.honk > 0 ? 1 : 0,
    })),
    peds: lobby.peds.map((p) => ({
      id: p.id,
      x: +p.x.toFixed(2),
      z: +p.z.toFixed(2),
      h: +p.heading.toFixed(3),
    })),
  };
}

function startLobbyLoop(lobby) {
  if (lobby.loopHandle) return;
  lobby.npcs = spawnNpcs(lobby);
  lobby.peds = spawnPedestrians(lobby);
  let tick = 0;
  lobby.loopHandle = setInterval(() => {
    stepNpcs(lobby);
    stepPedestrians(lobby);
    tick++;
    // Broadcast NPC state @ 20 Hz
    io.to(lobby.id).emit('npcUpdate', npcPayload(lobby));
  }, 1000 / TICK_HZ);
}

function stopLobbyLoop(lobby) {
  if (lobby.loopHandle) {
    clearInterval(lobby.loopHandle);
    lobby.loopHandle = null;
  }
}

function destroyLobby(lobby) {
  stopLobbyLoop(lobby);
  if (lobby.code) codeToLobby.delete(lobby.code);
  lobbies.delete(lobby.id);
}

// ---------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', lobbies: lobbies.size, uptime: process.uptime() });
});

app.get('/lobbies', (req, res) => {
  res.json({ lobbies: publicLobbyList() });
});

app.get('/', (req, res) => {
  res.send('3D Car Simulator server is running. See /health and /lobbies.');
});

// ---------------------------------------------------------------------
// Socket.IO handlers
// ---------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('[conn] ', socket.id);

  function currentLobby() {
    const id = socketToLobby.get(socket.id);
    return id ? lobbies.get(id) : null;
  }

  // ---- Create a lobby --------------------------------------------------
  socket.on('createLobby', (data, ack) => {
    try {
      const name = (data && data.playerName ? String(data.playerName) : 'Player').slice(0, 16);
      const lobbyName = (data && data.lobbyName ? String(data.lobbyName) : `${name}'s Lobby`).slice(0, 24);
      const id = uuidv4();
      const code = genJoinCode();

      const lobby = {
        id,
        code,
        name: lobbyName,
        hostId: socket.id,
        isPublic: !!(data && data.isPublic),
        maxPlayers: clampInt(data && data.maxPlayers, 2, 16, 8),
        worldSize: (data && data.worldSize) || 'medium',
        trafficDensity: (data && data.trafficDensity) || 'medium',
        timeOfDay: (data && data.timeOfDay) || 'day',
        weather: (data && data.weather) || 'clear',
        started: false,
        players: new Map(),
        npcs: [],
        peds: [],
        loopHandle: null,
      };

      const player = makePlayer(socket.id, name, data);
      lobby.players.set(socket.id, player);

      lobbies.set(id, lobby);
      codeToLobby.set(code, id);
      socketToLobby.set(socket.id, id);
      socket.join(id);

      if (ack) ack({ ok: true, lobby: lobbyMetaPayload(lobby), selfId: socket.id });
      io.to(id).emit('lobbyUpdate', lobbyMetaPayload(lobby));
    } catch (err) {
      console.error('createLobby error', err);
      if (ack) ack({ ok: false, error: 'Failed to create lobby' });
    }
  });

  // ---- Join a lobby (by code or public id) -----------------------------
  socket.on('joinLobby', (data, ack) => {
    try {
      let lobby = null;
      if (data && data.code) {
        const id = codeToLobby.get(String(data.code).toUpperCase());
        if (id) lobby = lobbies.get(id);
      } else if (data && data.lobbyId) {
        lobby = lobbies.get(data.lobbyId);
      }
      if (!lobby) { if (ack) ack({ ok: false, error: 'Lobby not found' }); return; }
      if (lobby.players.size >= lobby.maxPlayers) {
        if (ack) ack({ ok: false, error: 'Lobby is full' }); return;
      }
      if (lobby.started) {
        if (ack) ack({ ok: false, error: 'Game already started' }); return;
      }

      const name = (data && data.playerName ? String(data.playerName) : 'Player').slice(0, 16);
      const player = makePlayer(socket.id, name, data);
      lobby.players.set(socket.id, player);
      socketToLobby.set(socket.id, lobby.id);
      socket.join(lobby.id);

      if (ack) ack({ ok: true, lobby: lobbyMetaPayload(lobby), selfId: socket.id });
      io.to(lobby.id).emit('lobbyUpdate', lobbyMetaPayload(lobby));
      socket.to(lobby.id).emit('playerJoined', { id: socket.id, name });
    } catch (err) {
      console.error('joinLobby error', err);
      if (ack) ack({ ok: false, error: 'Failed to join lobby' });
    }
  });

  // ---- Update car/color selection while in lobby -----------------------
  socket.on('selectCar', (data) => {
    const lobby = currentLobby();
    if (!lobby) return;
    const p = lobby.players.get(socket.id);
    if (!p) return;
    if (data && data.carType) p.carType = String(data.carType);
    if (data && typeof data.color === 'number') p.color = data.color;
    io.to(lobby.id).emit('lobbyUpdate', lobbyMetaPayload(lobby));
  });

  // ---- Host changes lobby settings -------------------------------------
  socket.on('lobbySettings', (data) => {
    const lobby = currentLobby();
    if (!lobby || lobby.hostId !== socket.id) return;
    if (data.maxPlayers != null) lobby.maxPlayers = clampInt(data.maxPlayers, 2, 16, lobby.maxPlayers);
    if (data.worldSize) lobby.worldSize = data.worldSize;
    if (data.trafficDensity) lobby.trafficDensity = data.trafficDensity;
    if (data.timeOfDay) lobby.timeOfDay = data.timeOfDay;
    if (data.weather) lobby.weather = data.weather;
    if (typeof data.isPublic === 'boolean') lobby.isPublic = data.isPublic;
    io.to(lobby.id).emit('lobbyUpdate', lobbyMetaPayload(lobby));
  });

  // ---- Ready up --------------------------------------------------------
  socket.on('playerReady', (data) => {
    const lobby = currentLobby();
    if (!lobby) return;
    const p = lobby.players.get(socket.id);
    if (!p) return;
    p.ready = !!(data && data.ready);
    io.to(lobby.id).emit('lobbyUpdate', lobbyMetaPayload(lobby));
  });

  // ---- Start game (host only) ------------------------------------------
  socket.on('startGame', () => {
    const lobby = currentLobby();
    if (!lobby || lobby.hostId !== socket.id) return;
    lobby.started = true;
    startLobbyLoop(lobby);
    // give each player a spawn point along the start road
    let idx = 0;
    for (const p of lobby.players.values()) {
      const sx = WORLD.line(1) + idx * 6;
      const sz = WORLD.line(1) + 4;
      p.state = { x: sx, y: 0, z: sz, heading: 0, speed: 0, braking: false, nitro: false, damage: 0 };
      idx++;
    }
    io.to(lobby.id).emit('gameStart', {
      meta: lobbyMetaPayload(lobby),
      world: { blocks: WORLD.blocks, spacing: WORLD.spacing },
      npc: npcPayload(lobby),
    });
  });

  // ---- Player input / state (client-side physics, server relays) -------
  // Sent ~60Hz by clients; we store latest and rebroadcast @ 20Hz below.
  socket.on('playerInput', (s) => {
    const lobby = currentLobby();
    if (!lobby || !lobby.started) return;
    const p = lobby.players.get(socket.id);
    if (!p) return;
    // light validation / clamping to stop egregious cheating/teleporting
    if (!s || typeof s.x !== 'number' || typeof s.z !== 'number') return;
    const lim = WORLD.half + 60;
    p.state = {
      x: clampNum(s.x, -lim, lim),
      y: clampNum(s.y || 0, -5, 30),
      z: clampNum(s.z, -lim, lim),
      heading: Number(s.heading) || 0,
      speed: clampNum(s.speed || 0, -60, 120),
      braking: !!s.braking,
      nitro: !!s.nitro,
      steer: clampNum(s.steer || 0, -1, 1),
      damage: clampNum(s.damage || 0, 0, 1),
      horn: !!s.horn,
    };
  });

  // ---- RTT / ping echo -------------------------------------------------
  socket.on('rtt', (sentAt, ack) => { if (ack) ack(sentAt); });

  // ---- Chat ------------------------------------------------------------
  socket.on('chatMessage', (data) => {
    const lobby = currentLobby();
    if (!lobby) return;
    const p = lobby.players.get(socket.id);
    if (!p) return;
    const text = (data && data.text ? String(data.text) : '').slice(0, 160);
    if (!text.trim()) return;
    io.to(lobby.id).emit('chatMessage', { id: socket.id, name: p.name, text });
  });

  // ---- Leave lobby (back to menu) --------------------------------------
  socket.on('leaveLobby', () => {
    handleLeave(socket);
  });

  // ---- Disconnect ------------------------------------------------------
  socket.on('disconnect', () => {
    console.log('[disc] ', socket.id);
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const lobbyId = socketToLobby.get(socket.id);
  if (!lobbyId) return;
  const lobby = lobbies.get(lobbyId);
  socketToLobby.delete(socket.id);
  socket.leave(lobbyId);
  if (!lobby) return;

  const player = lobby.players.get(socket.id);
  lobby.players.delete(socket.id);
  io.to(lobbyId).emit('playerLeft', { id: socket.id, name: player ? player.name : '' });

  if (lobby.players.size === 0) {
    destroyLobby(lobby);
    return;
  }
  // reassign host if needed
  if (lobby.hostId === socket.id) {
    lobby.hostId = lobby.players.keys().next().value;
  }
  io.to(lobbyId).emit('lobbyUpdate', lobbyMetaPayload(lobby));
}

// ---------------------------------------------------------------------
// Player-update broadcast loop @ 20 Hz (rebroadcasts relayed inputs)
// ---------------------------------------------------------------------
setInterval(() => {
  for (const lobby of lobbies.values()) {
    if (!lobby.started) continue;
    const updates = [];
    for (const p of lobby.players.values()) {
      if (!p.state) continue;
      updates.push({
        id: p.id,
        name: p.name,
        carType: p.carType,
        color: p.color,
        x: +p.state.x.toFixed(2),
        y: +p.state.y.toFixed(2),
        z: +p.state.z.toFixed(2),
        h: +(p.state.heading || 0).toFixed(3),
        s: +(p.state.speed || 0).toFixed(1),
        st: +(p.state.steer || 0).toFixed(2),
        br: p.state.braking ? 1 : 0,
        ni: p.state.nitro ? 1 : 0,
        dmg: +(p.state.damage || 0).toFixed(2),
        horn: p.state.horn ? 1 : 0,
      });
    }
    io.to(lobby.id).emit('playerUpdate', { players: updates, t: Date.now() });
  }
}, 1000 / TICK_HZ);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function makePlayer(id, name, data) {
  return {
    id,
    name,
    carType: (data && data.carType) || 'sports',
    color: (data && typeof data.color === 'number') ? data.color : 0xff3344,
    ready: false,
    isHost: false,
    state: null,
  };
}

function clampInt(v, min, max, def) {
  v = parseInt(v, 10);
  if (Number.isNaN(v)) return def;
  return Math.max(min, Math.min(max, v));
}
function clampNum(v, min, max) {
  v = Number(v);
  if (Number.isNaN(v)) return 0;
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`3D Car Simulator server listening on port ${PORT}`);
  console.log(`CORS strict mode: ${STRICT_CORS}`);
});
