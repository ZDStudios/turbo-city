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
//
// Each lobby has its own world dimensions (set when the lobby is created
// from worldSize: 'small' | 'medium' | 'large' | 'huge'). The persistent
// public server uses 'huge' for a much bigger open-world map.
// ---------------------------------------------------------------------
const WORLD_SIZE_PRESETS = {
  small:  { blocks: 4,  spacing: 90 },
  medium: { blocks: 6,  spacing: 90 },
  large:  { blocks: 9,  spacing: 90 },
  huge:   { blocks: 14, spacing: 95 },   // ~1330 across — public server uses this
};
function worldFor(lobby) {
  const p = WORLD_SIZE_PRESETS[lobby.worldSize] || WORLD_SIZE_PRESETS.medium;
  const half = (p.blocks * p.spacing) / 2;
  return {
    blocks: p.blocks,
    spacing: p.spacing,
    half,
    line: (i) => -half + i * p.spacing,
  };
}
// Legacy/default used by features that don't yet take a lobby (race checkpoints).
const WORLD = { ...WORLD_SIZE_PRESETS.medium,
  get half() { return (this.blocks * this.spacing) / 2; },
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

// Super-admin: the secret code is validated SERVER-SIDE only, so it never
// ships to the browser and can't be found by inspecting the page source.
// Override on Render with an ADMIN_CODE env var if you want to change it.
const ADMIN_CODE = process.env.ADMIN_CODE || '6741';
const superAdmins = new Set(); // socket ids that entered the correct code

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
      hostName: host ? host.name : (lobby.hostName || 'Server'),
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
    mode: lobby.mode || 'open',
    cheats: !!lobby.cheats,
    started: lobby.started,
    players: lobbyPlayersPayload(lobby),
  };
}

// Race checkpoint loop around the inner city ring (matches client roads)
function buildRaceCheckpoints(lobby) {
  const W = worldFor(lobby);
  const a = W.line(1), b = W.line(W.blocks - 1), m = (a + b) / 2;
  return [
    { x: a, z: a }, { x: m, z: a }, { x: b, z: a }, { x: b, z: m },
    { x: b, z: b }, { x: m, z: b }, { x: a, z: b }, { x: a, z: m },
  ];
}

// Rocket pad positions — placed deterministically from the map seed so every
// client builds rockets in the same spots. Bigger maps get more rockets so
// you don't have to drive forever to find one.
function pickRocketPositions(W, seed) {
  // tiny seeded RNG (mulberry32-ish, fine for picking jitter)
  let a = (seed >>> 0) || 1;
  const rng = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const d = W.half - 30;
  // 4 corners + 4 mid-edges
  const cands = [
    { x:-d, z:-d }, { x: d, z:-d }, { x:-d, z: d }, { x: d, z: d },
    { x: 0, z:-d }, { x: 0, z: d }, { x:-d, z: 0 }, { x: d, z: 0 },
  ];
  // bigger maps host more rockets — 1 for small, 4 for huge
  const n = W.blocks <= 5 ? 1 : W.blocks <= 8 ? 2 : W.blocks <= 11 ? 3 : 4;
  // shuffle deterministically + take first n
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  return cands.slice(0, n);
}

function gameStartPayload(lobby) {
  const W = worldFor(lobby);
  const rockets = pickRocketPositions(W, lobby.mapSeed);
  lobby._rockets = rockets;
  if (!lobby._rocketBusy) lobby._rocketBusy = new Array(rockets.length).fill(0);
  // ensure cooldown array length matches if rockets were rebuilt
  while (lobby._rocketBusy.length < rockets.length) lobby._rocketBusy.push(0);
  return {
    meta: lobbyMetaPayload(lobby),
    world: { blocks: W.blocks, spacing: W.spacing, seed: lobby.mapSeed },
    npc: npcPayload(lobby),
    mode: lobby.mode || 'open',
    cheats: !!lobby.cheats,
    race: lobby.race
      ? { checkpoints: lobby.race.checkpoints, laps: lobby.race.laps, startAt: lobby.race.startAt }
      : null,
    rockets,                    // array of {x, z}
    rocket: rockets[0],         // backward-compat for older clients
  };
}

// ---------------------------------------------------------------------
// NPC simulation
// ---------------------------------------------------------------------
// Build a set of rectangular loop paths along the road grid. NPC cars
// follow these waypoint loops; pedestrians walk shorter sidewalk loops.

function buildNpcPaths(W) {
  W = W || WORLD;
  const paths = [];
  const b = W.blocks;
  // Perimeter loop + a few inner rectangular loops between grid lines.
  const rects = [
    [0, 0, b, b],
    [1, 1, b - 1, b - 1],
    [0, 1, b - 1, b],
    [1, 0, b, b - 1],
  ];
  // bigger maps get extra middle loops so NPCs aren't all bunched around the rim
  if (b >= 9) {
    const m = Math.floor(b/2);
    rects.push([m-2, m-2, m+2, m+2], [m-3, m-1, m+1, m+3]);
  }
  for (const [i0, j0, i1, j1] of rects) {
    const x0 = W.line(i0), z0 = W.line(j0);
    const x1 = W.line(i1), z1 = W.line(j1);
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

function spawnNpcs(lobby) {
  const W = worldFor(lobby);
  lobby._world = W;
  lobby._npcPaths = buildNpcPaths(W);
  const density = lobby.trafficDensity || 'medium';
  let count = density === 'low' ? 10 : density === 'high' ? 28 : 18;
  if (W.blocks >= 9) count = Math.round(count * 2);   // bigger maps -> more traffic
  const npcs = [];
  const colors = [0x3366cc, 0xcc3333, 0x33aa55, 0xddaa22, 0x9933cc, 0x444444, 0xdddddd];
  for (let i = 0; i < count; i++) {
    const path = lobby._npcPaths[i % lobby._npcPaths.length];
    const seg = Math.floor(Math.random() * path.length);
    const a = path[seg];
    const bpt = path[(seg + 1) % path.length];
    const t = Math.random();
    npcs.push({
      id: 'npc_' + i,
      path: i % lobby._npcPaths.length,
      seg,
      t,
      x: a.x + (bpt.x - a.x) * t,
      z: a.z + (bpt.z - a.z) * t,
      y: 0, vy: 0,
      heading: Math.atan2(bpt.x - a.x, bpt.z - a.z),
      speed: 0,
      maxSpeed: 16 + Math.random() * 10,
      color: colors[i % colors.length],
      honk: 0,
      stopped: false,
      knockVx: 0, knockVz: 0, knockSpin: 0, spin: 0,
      // tumble: roll = around forward axis, pitch = around side axis
      roll: 0, pitch: 0, rollVel: 0, pitchVel: 0,
      hp: 100,                  // bullets chip away at this — 0 = explode
    });
  }
  return npcs;
}

function spawnPedestrians(lobby) {
  const W = lobby._world || worldFor(lobby);
  let count = 12;
  if (W.blocks >= 9) count = 24;
  const peds = [];
  for (let i = 0; i < count; i++) {
    // pedestrians loop a small rectangle near a random block corner
    const gi = 1 + Math.floor(Math.random() * (W.blocks - 1));
    const gj = 1 + Math.floor(Math.random() * (W.blocks - 1));
    const cx = W.line(gi);
    const cz = W.line(gj);
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
  const W = lobby._world || worldFor(lobby);
  const paths = lobby._npcPaths || buildNpcPaths(W);
  const npcs = lobby.npcs;
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    const path = paths[n.path];
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
    const nearLineX = Math.abs((((n.x + W.half) % W.spacing) + W.spacing) % W.spacing) < 6;
    const nearLineZ = Math.abs((((n.z + W.half) % W.spacing) + W.spacing) % W.spacing) < 6;
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

    // --- ramming: players knock NPCs around and tumble them ---
    for (const p of lobby.players.values()) {
      if (!p.state) continue;
      const dx = n.x - p.state.x, dz = n.z - p.state.z;
      const dd = Math.hypot(dx, dz);
      if (dd < 4.2 && dd > 0.001) {
        const nx = dx / dd, nz = dz / dd;
        const ps = Math.abs(p.state.speed || 0);
        if (ps > 10) {
          const f = Math.min(90, ps);
          n.knockVx += nx * f * 1.0;
          n.knockVz += nz * f * 1.0;
          n.vy = Math.max(n.vy, Math.min(16, f * 0.28));
          n.knockSpin += (Math.random() - 0.5) * 8;
          // tip them over: side hits roll, head-on hits pitch
          n.rollVel  += (Math.random() - 0.5) * 7;
          n.pitchVel += (Math.random() - 0.5) * 5;
        } else {
          n.x += nx * (4.2 - dd);
          n.z += nz * (4.2 - dd);
        }
      }
    }
    // integrate knockback impulse + vertical hop
    n.x += n.knockVx * DT; n.z += n.knockVz * DT;
    n.knockVx *= 0.9; n.knockVz *= 0.9;
    n.y += n.vy * DT;
    if (n.y > 0) n.vy -= 26 * DT; else { n.y = 0; n.vy = 0; }
    n.spin += n.knockSpin * DT; n.knockSpin *= 0.92;
    // integrate roll/pitch (tumble) — NPCs land tipped then slowly right themselves
    n.roll  += n.rollVel  * DT;
    n.pitch += n.pitchVel * DT;
    n.rollVel  *= 0.94;
    n.pitchVel *= 0.94;
    if (n.y <= 0.05) { n.roll *= 0.965; n.pitch *= 0.965; }

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
      y: +(n.y || 0).toFixed(2),
      h: +(n.heading + (n.spin || 0)).toFixed(3),
      r: +(n.roll || 0).toFixed(3),
      p: +(n.pitch || 0).toFixed(3),
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
  if (lobby.persistent) return; // the official public server never closes
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
        maxPlayers: clampInt(data && data.maxPlayers, 2, 32, 8),
        worldSize: (data && data.worldSize) || 'medium',
        trafficDensity: (data && data.trafficDensity) || 'medium',
        timeOfDay: (data && data.timeOfDay) || 'day',
        weather: (data && data.weather) || 'clear',
        mode: (data && data.mode) || 'open',
        cheats: !!(data && data.cheats),
        mapSeed: (Math.random() * 1e9) | 0,
        race: null,
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

      const name = (data && data.playerName ? String(data.playerName) : 'Player').slice(0, 16);
      const player = makePlayer(socket.id, name, data);
      lobby.players.set(socket.id, player);
      socketToLobby.set(socket.id, lobby.id);
      socket.join(lobby.id);

      if (ack) ack({ ok: true, lobby: lobbyMetaPayload(lobby), selfId: socket.id, started: lobby.started });
      io.to(lobby.id).emit('lobbyUpdate', lobbyMetaPayload(lobby));
      socket.to(lobby.id).emit('playerJoined', { id: socket.id, name });

      // If the game is already running, drop the late-joiner straight in.
      if (lobby.started) {
        player.state = spawnState(lobby);
        if (lobby.race) {
          lobby.race.standings[socket.id] = { lap: 1, cp: 0, finished: false, place: 0, finishMs: 0 };
        }
        socket.emit('gameStart', gameStartPayload(lobby));
      }
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
    if (data.maxPlayers != null) lobby.maxPlayers = clampInt(data.maxPlayers, 2, 32, lobby.maxPlayers);
    if (data.worldSize) lobby.worldSize = data.worldSize;
    if (data.trafficDensity) lobby.trafficDensity = data.trafficDensity;
    if (data.timeOfDay) lobby.timeOfDay = data.timeOfDay;
    if (data.weather) lobby.weather = data.weather;
    if (data.mode) lobby.mode = data.mode === 'race' ? 'race' : 'open';
    if (typeof data.cheats === 'boolean') lobby.cheats = data.cheats;
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
    lobby.mapSeed = (Math.random() * 1e9) | 0; // fresh random map each game
    startLobbyLoop(lobby);

    // set up race state if this is a race lobby
    if (lobby.mode === 'race') {
      lobby.race = {
        checkpoints: buildRaceCheckpoints(lobby),
        laps: 3,
        startAt: Date.now() + 5000, // 5s countdown
        finishers: 0,
        standings: {},
      };
      for (const p of lobby.players.values()) {
        lobby.race.standings[p.id] = { lap: 1, cp: 0, finished: false, place: 0, finishMs: 0 };
      }
    } else {
      lobby.race = null;
    }

    for (const p of lobby.players.values()) {
      p.state = spawnState(lobby);
    }
    io.to(lobby.id).emit('gameStart', gameStartPayload(lobby));
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
    const W = lobby._world || worldFor(lobby);
    const lim = W.half + 60;
    p.state = {
      x: clampNum(s.x, -lim, lim),
      y: clampNum(s.y || 0, -40, 400),
      z: clampNum(s.z, -lim, lim),
      heading: Number(s.heading) || 0,
      speed: clampNum(s.speed || 0, -60, 120),
      braking: !!s.braking,
      nitro: !!s.nitro,
      steer: clampNum(s.steer || 0, -1, 1),
      damage: clampNum(s.damage || 0, 0, 1),
      horn: !!s.horn,
      turret: !!s.turret,
      health: clampNum(s.health == null ? 100 : s.health, 0, 100),
    };
  });

  // ---- RTT / ping echo -------------------------------------------------
  socket.on('rtt', (sentAt, ack) => { if (ack) ack(sentAt); });

  // ---- Super-admin login (code checked server-side only) ---------------
  socket.on('adminLogin', (d, ack) => {
    const code = d && d.code != null ? String(d.code).trim() : '';
    if (code === ADMIN_CODE) {
      superAdmins.add(socket.id);
      console.log('[admin] granted to', socket.id);
      if (ack) ack({ ok: true });
    } else {
      if (ack) ack({ ok: false, error: 'Invalid code' });
    }
  });

  // ---- Combat: turret fire (visual relay) + hits + kills ---------------
  socket.on('fire', (d) => {
    const lobby = currentLobby();
    if (!lobby || !d) return;
    // relay the shot to everyone else so they can render a tracer
    socket.to(lobby.id).emit('fire', {
      id: socket.id,
      x: clampNum(d.x, -1000, 1000), y: clampNum(d.y, -50, 500), z: clampNum(d.z, -1000, 1000),
      h: Number(d.h) || 0,
    });
  });

  socket.on('hitPlayer', (d) => {
    const lobby = currentLobby();
    if (!lobby || !d || !d.targetId) return;
    if (!lobby.players.has(d.targetId)) return;
    const shooter = lobby.players.get(socket.id);
    const target = lobby.players.get(d.targetId);
    const dmg = clampNum(d.dmg, 0, 40);
    io.to(d.targetId).emit('damaged', { from: socket.id, fromName: shooter ? shooter.name : '?', dmg });
    // also blast them — a hit sends them flying away from the shooter
    if (shooter && shooter.state && target && target.state) {
      const dx = target.state.x - shooter.state.x;
      const dz = target.state.z - shooter.state.z;
      const dd = Math.hypot(dx, dz) || 1;
      const nx = dx/dd, nz = dz/dd;
      const f = 70 + dmg * 5;
      io.to(d.targetId).emit('collision', {
        vx: nx * f * 0.9, vz: nz * f * 0.9,
        up: 14, spin: (Math.random() - 0.5) * 6,
      });
    }
  });

  // ---- Shoot an NPC car: server applies a huge knock + tumble -----------
  socket.on('hitNpc', (d) => {
    const lobby = currentLobby();
    if (!lobby || !d || !d.id) return;
    const n = lobby.npcs.find((o) => o.id === d.id);
    if (!n) return;
    const dx = Number(d.dx) || 0, dz = Number(d.dz) || 0;
    const dl = Math.hypot(dx, dz) || 1;
    const nx = dx/dl, nz = dz/dl;
    const dmg = clampNum(d.dmg, 0, 40);
    const f = 90 + dmg * 4;
    n.knockVx += nx * f * 1.1;
    n.knockVz += nz * f * 1.1;
    n.vy = Math.max(n.vy, 16);
    n.knockSpin += (Math.random() - 0.5) * 10;
    n.rollVel  += (Math.random() - 0.5) * 9;
    n.pitchVel += (Math.random() - 0.5) * 6;
    // chip HP; if destroyed -> tell everyone to explode it, then respawn it
    n.hp = (n.hp == null ? 100 : n.hp) - (dmg || 12);
    if (n.hp <= 0) {
      io.to(lobby.id).emit('npcDestroyed', {
        id: n.id, x: n.x, y: n.y || 0, z: n.z,
      });
      // respawn on a fresh waypoint after a short delay (so explosion plays)
      const path = (lobby._npcPaths || buildNpcPaths(worldFor(lobby)))[n.path];
      const a = path[0], b = path[1];
      setTimeout(() => {
        if (!lobbies.has(lobby.id)) return;
        n.x = a.x + (b.x - a.x) * Math.random();
        n.z = a.z + (b.z - a.z) * Math.random();
        n.y = 0; n.vy = 0;
        n.knockVx = 0; n.knockVz = 0; n.knockSpin = 0; n.spin = 0;
        n.roll = 0; n.pitch = 0; n.rollVel = 0; n.pitchVel = 0;
        n.heading = Math.atan2(b.x - a.x, b.z - a.z);
        n.speed = 0; n.seg = 0; n.hp = 100;
      }, 800);
    }
  });

  // ---- Hit a pedestrian: squish/blow up + respawn at a new corner --------
  socket.on('hitPed', (d) => {
    const lobby = currentLobby();
    if (!lobby || !d || !d.id) return;
    const p = lobby.peds.find((o) => o.id === d.id);
    if (!p) return;
    io.to(lobby.id).emit('pedHit', { id: p.id, x: p.x, y: 0, z: p.z });
    // respawn elsewhere
    const W = lobby._world || worldFor(lobby);
    const gi = 1 + Math.floor(Math.random() * (W.blocks - 1));
    const gj = 1 + Math.floor(Math.random() * (W.blocks - 1));
    const cx = W.line(gi), cz = W.line(gj), r = 8;
    p.loop = [
      { x: cx - r, z: cz - r }, { x: cx + r, z: cz - r },
      { x: cx + r, z: cz + r }, { x: cx - r, z: cz + r },
    ];
    p.x = cx; p.z = cz; p.seg = 0; p.heading = 0;
  });

  socket.on('iDied', (d) => {
    const lobby = currentLobby();
    if (!lobby) return;
    const victim = lobby.players.get(socket.id);
    const killer = d && d.by ? lobby.players.get(d.by) : null;
    io.to(lobby.id).emit('killFeed', {
      killerId: d && d.by ? d.by : null,
      killer: killer ? killer.name : 'the world',
      victim: victim ? victim.name : '?',
    });
  });

  // ---- ROCKET LAUNCH: drive into ANY rocket pad to take off. The launching
  //      player + which pad they used is broadcast to everyone.
  socket.on('rocketLaunch', () => {
    const lobby = currentLobby();
    if (!lobby || !lobby.started) return;
    const p = lobby.players.get(socket.id);
    if (!p || !p.state || !lobby._rockets || lobby._rockets.length === 0) return;
    const now = Date.now();
    // find which pad they're standing on (closest one within range)
    let bestIdx = -1, bestD = 100;  // ~10m radius
    for (let i = 0; i < lobby._rockets.length; i++) {
      const r = lobby._rockets[i];
      const dx = p.state.x - r.x, dz = p.state.z - r.z;
      const d = dx*dx + dz*dz;
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx < 0) return;
    // per-pad cooldown so different pads can launch independently
    if ((lobby._rocketBusy[bestIdx] || 0) > now) return;
    lobby._rocketBusy[bestIdx] = now + 14000;    // 8s launch + 6s cooldown
    const r = lobby._rockets[bestIdx];
    io.to(lobby.id).emit('rocketLaunch', {
      id: socket.id,
      name: p.name,
      x: r.x, z: r.z,
      padIdx: bestIdx,
      t: now,
    });
  });

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

  // ---- Race progress (client reports checkpoint/lap; server ranks) -----
  socket.on('raceProgress', (d) => {
    const lobby = currentLobby();
    if (!lobby || !lobby.race) return;
    const st = lobby.race.standings[socket.id];
    if (!st || st.finished) return;
    if (d) {
      st.lap = clampInt(d.lap, 0, 99, st.lap);
      st.cp = clampInt(d.cp, 0, 99, st.cp);
      if (d.finished) {
        st.finished = true;
        st.place = ++lobby.race.finishers;
        st.finishMs = Date.now() - lobby.race.startAt;
        const reward = Math.max(50, 400 - (st.place - 1) * 100); // 1st=400, 2nd=300...
        io.to(lobby.id).emit('raceFinished', {
          id: socket.id,
          name: lobby.players.get(socket.id) ? lobby.players.get(socket.id).name : '',
          place: st.place,
          ms: st.finishMs,
          reward,
        });
      }
    }
  });

  // ---- Admin / cheat commands (host only, cheats must be enabled) ------
  socket.on('adminCommand', (d) => {
    const lobby = currentLobby();
    if (!lobby || !d) return;
    const sa = superAdmins.has(socket.id);
    if (!sa && (lobby.hostId !== socket.id || !lobby.cheats)) return; // super-admins bypass host/cheats
    const hostName = lobby.players.get(socket.id) ? lobby.players.get(socket.id).name : 'Admin';
    if (d.cmd === 'kick' && d.targetId && lobby.players.has(d.targetId) && d.targetId !== socket.id) {
      io.to(d.targetId).emit('kicked', { reason: 'Kicked by host' });
      const ts = io.sockets.sockets.get(d.targetId);
      if (ts) handleLeave(ts);
      return;
    }
    // ---- MISSILE: spectacular admin-only kill that everyone sees ----
    if (d.cmd === 'missile' && d.targetId && lobby.players.has(d.targetId)) {
      const host = lobby.players.get(socket.id);
      const target = lobby.players.get(d.targetId);
      if (!target || !target.state) return;
      // origin: high above the host (or above the target if host has no state)
      const ox = host && host.state ? host.state.x : target.state.x;
      const oz = host && host.state ? host.state.z : target.state.z;
      const oy = (host && host.state ? host.state.y : 0) + 80;
      const flightMs = 2600;          // longer so everyone can clearly see it arcing
      io.to(lobby.id).emit('missile', {
        from: socket.id,
        fromName: hostName,
        targetId: d.targetId,
        targetName: target.name,
        ox, oy, oz,
        flightMs,
        t: Date.now(),
      });
      // when it lands: tell the target to play the death/space-launch FX
      // (NO account reset — coins/upgrades are preserved unless admin uses 'reset')
      setTimeout(() => {
        if (!lobbies.has(lobby.id)) return;
        if (!lobby.players.has(d.targetId)) return;
        io.to(d.targetId).emit('missileHit', { from: hostName });
        io.to(lobby.id).emit('killFeed', {
          killerId: socket.id,
          killer: hostName + ' 🚀',
          victim: target.name,
        });
      }, flightMs);
      return;
    }
    // ---- RESET: wipe target's coins/upgrades/turret to a fresh account ----
    if (d.cmd === 'reset' && d.targetId && lobby.players.has(d.targetId)) {
      const target = lobby.players.get(d.targetId);
      io.to(d.targetId).emit('resetAccount', { reason: 'admin', from: hostName });
      return;
    }
    const actions = ['trap', 'untrap', 'fly', 'heal', 'boost', 'bringToMe', 'control', 'release'];
    if (actions.includes(d.cmd) && d.targetId && lobby.players.has(d.targetId)) {
      const host = lobby.players.get(socket.id);
      io.to(d.targetId).emit('admin', {
        action: d.cmd,
        from: hostName,
        hostPos: d.cmd === 'bringToMe' && host ? host.state : undefined,
      });
    }
  });

  // ---- Control relay: host puppets a target with their own inputs ------
  socket.on('controlInput', (d) => {
    const lobby = currentLobby();
    if (!lobby || !d || !d.targetId) return;
    const sa = superAdmins.has(socket.id);
    if (!sa && (lobby.hostId !== socket.id || !lobby.cheats)) return;
    if (lobby.players.has(d.targetId)) io.to(d.targetId).emit('controlled', d.input || {});
  });

  // ---- Leave lobby (back to menu) --------------------------------------
  socket.on('leaveLobby', () => {
    handleLeave(socket);
  });

  // ---- Disconnect ------------------------------------------------------
  socket.on('disconnect', () => {
    console.log('[disc] ', socket.id);
    superAdmins.delete(socket.id);
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
    if (lobby.persistent) return; // keep the official server alive when empty
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

    // --- player vs player collisions -> send impulses to both clients ---
    const active = [...lobby.players.values()].filter((p) => p.state);
    if (!lobby._coll) lobby._coll = {};
    const now = Date.now();
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const dx = a.state.x - b.state.x, dz = a.state.z - b.state.z;
        const dd = Math.hypot(dx, dz);
        if (dd >= 4.2 || dd <= 0.001) continue;
        const nx = dx / dd, nz = dz / dd;
        const closing = Math.abs(a.state.speed || 0) + Math.abs(b.state.speed || 0);
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        if (closing > 8 && (!lobby._coll[key] || now - lobby._coll[key] > 300)) {
          lobby._coll[key] = now;
          const f = Math.min(120, closing);
          const up = Math.min(18, f * 0.24);     // faster hit -> launched higher
          const spin = (Math.random() - 0.5) * 0.10 * f; // and tumbling more
          io.to(a.id).emit('collision', { vx: nx * f * 0.85, vz: nz * f * 0.85, up, spin });
          io.to(b.id).emit('collision', { vx: -nx * f * 0.85, vz: -nz * f * 0.85, up, spin: -spin });
        }
      }
    }

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
        tur: p.state.turret ? 1 : 0,
        hp: Math.round(p.state.health == null ? 100 : p.state.health),
      });
    }
    io.to(lobby.id).emit('playerUpdate', { players: updates, t: Date.now() });

    // race standings (live positions)
    if (lobby.race) {
      const arr = Object.entries(lobby.race.standings).map(([id, s]) => ({
        id, lap: s.lap, cp: s.cp, finished: s.finished, place: s.place, ms: s.finishMs,
        name: lobby.players.get(id) ? lobby.players.get(id).name : '?',
      }));
      arr.sort((p, q) => {
        if (p.finished && q.finished) return p.place - q.place;
        if (p.finished) return -1;
        if (q.finished) return 1;
        return (q.lap * 100 + q.cp) - (p.lap * 100 + p.cp);
      });
      arr.forEach((p, i) => { p.pos = i + 1; });
      io.to(lobby.id).emit('raceStandings', arr);
    }
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

// Spawn point spread along the start road; small random offset so late
// joiners don't all stack on the same spot.
function spawnState(lobby) {
  const W = lobby._world || worldFor(lobby);
  const idx = lobby.players.size;
  const sx = W.line(1) + (idx % 8) * 6 + (Math.random() - 0.5) * 3;
  const sz = W.line(1) + 4 + Math.floor(idx / 8) * 6;
  return { x: sx, y: 0, z: sz, heading: 0, speed: 0, braking: false, nitro: false, damage: 0 };
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
// Persistent official public server — always online, up to 32 players,
// open-world running 24/7 so anyone can drop in any time.
// ---------------------------------------------------------------------
function createPersistentLobby() {
  const id = 'official-open-world';
  const code = 'PUBLIC';
  const lobby = {
    id, code,
    name: '🌍 Official Open World',
    hostId: 'server',
    hostName: 'Server',
    isPublic: true,
    persistent: true,
    maxPlayers: 32,
    worldSize: 'huge',           // public server is much bigger than private lobbies
    trafficDensity: 'high',
    timeOfDay: 'day',
    weather: 'clear',
    mode: 'open',
    cheats: false,
    mapSeed: (Math.random() * 1e9) | 0,
    race: null,
    started: true,
    players: new Map(),
    npcs: [], peds: [],
    loopHandle: null,
  };
  lobbies.set(id, lobby);
  codeToLobby.set(code, id);
  startLobbyLoop(lobby);
  console.log('Persistent public lobby running:', lobby.name);
}

server.listen(PORT, () => {
  console.log(`3D Car Simulator server listening on port ${PORT}`);
  console.log(`CORS strict mode: ${STRICT_CORS}`);
  createPersistentLobby();
});
