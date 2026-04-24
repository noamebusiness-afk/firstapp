// server.js - Sumo Faces real-time multiplayer server
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6, // 5MB for base64 face images
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Game constants ----------
const TICK_RATE = 30; // server ticks per second
const ARENA_RADIUS = 400;
const ARENA_CENTER = { x: 500, y: 500 };
const PLAYER_RADIUS = 40;
const PLAYER_MASS = 1;
const ACCEL = 0.55;
const FRICTION = 0.94;
const MAX_SPEED = 8;
const COUNTDOWN_SECONDS = 3;
const WIN_DISPLAY_MS = 5000;

const FRUIT_RADIUS = 18;
const MAX_FRUITS = 4;
const FRUIT_TYPES = ['🍎','🍊','🍇','🍌','🍓'];
const TZOFI_ID = 'bot-tzofi';
const TZOFI_SPEED = 6;
const TZOFI_ACCEL = 0.45;

// ---------- State ----------
const STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  ENDED: 'ended',
};

let gameState = STATE.LOBBY;
let players = {}; // id -> { id, name, face, x, y, vx, vy, input, alive, eliminatedAt, fallRotation, fallScale }
let countdownTimer = null;
let gameEndTimer = null;
let fruits = [];
let tickCount = 0;

function newSpawnPosition(index, total) {
  // Ring spawn around center
  const angle = (index / Math.max(total, 1)) * Math.PI * 2;
  const r = ARENA_RADIUS * 0.55;
  return {
    x: ARENA_CENTER.x + Math.cos(angle) * r,
    y: ARENA_CENTER.y + Math.sin(angle) * r,
  };
}

function playerRadius(p) {
  return PLAYER_RADIUS * (1 + (p.sizeBonus || 0) * 0.2);
}

function broadcastLobby() {
  const list = Object.values(players).map(p => ({
    id: p.id,
    name: p.name,
    face: p.face,
    ready: p.ready || false,
  }));
  io.emit('lobby:update', { players: list, state: gameState });
}

function snapshot() {
  return {
    players: Object.values(players).map(p => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      alive: p.alive,
      fallRotation: p.fallRotation,
      fallScale: p.fallScale,
      sizeBonus: p.sizeBonus || 0,
      isBot: p.isBot || false,
    })),
    fruits,
    state: gameState,
  };
}

// ---------- Physics ----------
function stepPhysics() {
  const list = Object.values(players);

  // Apply inputs, velocity, friction
  for (const p of list) {
    if (!p.alive) {
      // Falling animation
      p.fallRotation += 0.25;
      p.fallScale *= 0.96;
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.99;
      p.vy *= 0.99;
      continue;
    }

    const i = p.input || {};
    let ax = 0, ay = 0;
    if (i.up) ay -= ACCEL;
    if (i.down) ay += ACCEL;
    if (i.left) ax -= ACCEL;
    if (i.right) ax += ACCEL;

    p.vx += ax;
    p.vy += ay;
    p.vx *= FRICTION;
    p.vy *= FRICTION;

    // Cap speed
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > MAX_SPEED) {
      p.vx = (p.vx / sp) * MAX_SPEED;
      p.vy = (p.vy / sp) * MAX_SPEED;
    }

    p.x += p.vx;
    p.y += p.vy;
  }

  // Elastic collisions between alive players
  const alive = list.filter(p => p.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      const minDist = playerRadius(a) + playerRadius(b);

      if (dist < minDist) {
        // Normalize
        const nx = dx / dist;
        const ny = dy / dist;

        // Separate the circles
        const overlap = (minDist - dist) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        // Relative velocity along normal
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const velAlongNormal = rvx * nx + rvy * ny;
        if (velAlongNormal > 0) continue; // already separating

        const restitution = 1.6; // strong sumo push
        const jImp = -(1 + restitution) * velAlongNormal / (1 / PLAYER_MASS + 1 / PLAYER_MASS);

        const impulseX = jImp * nx;
        const impulseY = jImp * ny;

        a.vx -= impulseX / PLAYER_MASS;
        a.vy -= impulseY / PLAYER_MASS;
        b.vx += impulseX / PLAYER_MASS;
        b.vy += impulseY / PLAYER_MASS;
      }
    }
  }

  // Check eliminations (center-of-face outside the arena)
  for (const p of alive) {
    const d = Math.hypot(p.x - ARENA_CENTER.x, p.y - ARENA_CENTER.y);
    if (d > ARENA_RADIUS) {
      p.alive = false;
      p.eliminatedAt = Date.now();
      p.fallRotation = 0;
      p.fallScale = 1;
      io.emit('game:eliminated', { id: p.id, name: p.name });
    }
  }

  // Fruit eating
  for (const p of alive) {
    for (let fi = fruits.length - 1; fi >= 0; fi--) {
      const f = fruits[fi];
      const d = Math.hypot(p.x - f.x, p.y - f.y);
      if (d < playerRadius(p) + FRUIT_RADIUS) {
        p.sizeBonus = (p.sizeBonus || 0) + 1;
        const msgs = [
          'אכלת פרי! אתה שמן עכשיו',
          'וואו! עוד אחד? אתה ממש ענק!',
          'אי אפשר לעצור אותך!',
        ];
        io.emit('fruit:eaten', {
          playerId: p.id,
          playerName: p.name,
          fruitType: f.type,
          message: msgs[Math.min((p.sizeBonus - 1), msgs.length - 1)],
        });
        fruits.splice(fi, 1);
      }
    }
  }

  // Win condition
  if (gameState === STATE.PLAYING) {
    const stillAlive = list.filter(p => p.alive);
    if (stillAlive.length <= 1 && list.length >= 1) {
      gameState = STATE.ENDED;
      const winner = stillAlive[0] || null;
      io.emit('game:winner', winner ? { id: winner.id, name: winner.name, face: winner.face } : null);
      clearTimeout(gameEndTimer);
      gameEndTimer = setTimeout(returnToLobby, WIN_DISPLAY_MS);
    }
  }
}

function returnToLobby() {
  gameState = STATE.LOBBY;
  fruits = [];
  tickCount = 0;
  delete players[TZOFI_ID];
  for (const p of Object.values(players)) {
    p.alive = true;
    p.vx = 0;
    p.vy = 0;
    p.fallRotation = 0;
    p.fallScale = 1;
    p.input = {};
    p.sizeBonus = 0;
    p.ready = false;
  }
  broadcastLobby();
  io.emit('game:to_lobby');
}

function startCountdown() {
  if (gameState !== STATE.LOBBY) return;
  const list = Object.values(players);
  if (list.length < 1) return;

  gameState = STATE.COUNTDOWN;
  // Place players around the ring
  list.forEach((p, idx) => {
    const pos = newSpawnPosition(idx, list.length);
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.alive = true;
    p.fallRotation = 0;
    p.fallScale = 1;
    p.input = {};
  });

  // Spawn Tzofi NPC alongside human players
  const tzofiPos = newSpawnPosition(list.length, list.length + 1);
  players[TZOFI_ID] = {
    id: TZOFI_ID, name: 'צופי', face: null,
    x: tzofiPos.x, y: tzofiPos.y,
    vx: 0, vy: 0, input: {}, alive: true,
    fallRotation: 0, fallScale: 1,
    isBot: true, sizeBonus: 0,
  };

  io.emit('game:countdown_start', { seconds: COUNTDOWN_SECONDS });

  let remaining = COUNTDOWN_SECONDS;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      gameState = STATE.PLAYING;
      io.emit('game:start');
    } else {
      io.emit('game:countdown_tick', { remaining });
    }
  }, 1000);
}

function stepTzofi() {
  const tz = players[TZOFI_ID];
  if (!tz || !tz.alive) return;

  const targets = Object.values(players).filter(p => p.alive && p.id !== TZOFI_ID);
  if (targets.length === 0) return;

  let nearest = null, nearD = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.x - tz.x, t.y - tz.y);
    if (d < nearD) { nearD = d; nearest = t; }
  }

  if (nearest) {
    const dx = nearest.x - tz.x;
    const dy = nearest.y - tz.y;
    const len = Math.hypot(dx, dy) || 1;
    tz.vx += (dx / len) * TZOFI_ACCEL;
    tz.vy += (dy / len) * TZOFI_ACCEL;
  }

  const sp = Math.hypot(tz.vx, tz.vy);
  if (sp > TZOFI_SPEED) {
    tz.vx = (tz.vx / sp) * TZOFI_SPEED;
    tz.vy = (tz.vy / sp) * TZOFI_SPEED;
  }

  // Nudge back toward center if getting close to edge
  const distFromCenter = Math.hypot(tz.x - ARENA_CENTER.x, tz.y - ARENA_CENTER.y);
  if (distFromCenter > ARENA_RADIUS * 0.85) {
    const ang = Math.atan2(ARENA_CENTER.y - tz.y, ARENA_CENTER.x - tz.x);
    tz.vx += Math.cos(ang) * 0.8;
    tz.vy += Math.sin(ang) * 0.8;
  }
}

// ---------- Tick loop ----------
setInterval(() => {
  tickCount++;
  if (gameState === STATE.PLAYING || gameState === STATE.ENDED || gameState === STATE.COUNTDOWN) {
    if (gameState === STATE.PLAYING || gameState === STATE.ENDED) {
      if (gameState === STATE.PLAYING) stepTzofi();
      stepPhysics();
    }
    if (gameState === STATE.PLAYING) {
      if (fruits.length < MAX_FRUITS && tickCount % 150 === 0) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * ARENA_RADIUS * 0.72;
        fruits.push({
          id: tickCount,
          x: ARENA_CENTER.x + Math.cos(angle) * dist,
          y: ARENA_CENTER.y + Math.sin(angle) * dist,
          type: FRUIT_TYPES[Math.floor(Math.random() * FRUIT_TYPES.length)],
        });
      }
      if (players[TZOFI_ID] && tickCount % 180 === 0) {
        io.emit('tzofi:bark');
      }
    }
    io.emit('game:snapshot', snapshot());
  }
}, 1000 / TICK_RATE);

// ---------- Socket events ----------
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('player:join', ({ name, face }) => {
    if (!name || !face) return;
    const clean = String(name).slice(0, 20).trim() || 'Unnamed';
    const idx = Object.keys(players).length;
    const pos = newSpawnPosition(idx, Object.keys(players).length + 1);

    const peerIds = Object.keys(players); // existing peers before adding self
    players[socket.id] = {
      id: socket.id,
      name: clean,
      face,
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      input: {},
      alive: true,
      fallRotation: 0,
      fallScale: 1,
      ready: false,
    };

    socket.emit('player:joined', { id: socket.id, peerIds });
    broadcastLobby();
    console.log(`${clean} joined (${socket.id})`);
  });

  // Live face update from webcam stream
  socket.on('player:face_update', ({ face }) => {
    const p = players[socket.id];
    if (!p || !face) return;
    p.face = face;
    socket.broadcast.emit('player:face_updated', { id: socket.id, face });
  });

  // WebRTC signaling
  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });
  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });
  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  socket.on('player:ready', () => {
    const p = players[socket.id];
    if (!p || gameState !== STATE.LOBBY) return;
    p.ready = true;
    broadcastLobby();
    const all = Object.values(players);
    if (all.length >= 1 && all.every(pp => pp.ready)) {
      startCountdown();
    }
  });

  socket.on('game:start_request', () => {
    const all = Object.values(players);
    if (all.length >= 1 && all.every(pp => pp.ready)) startCountdown();
  });

  socket.on('player:input', (input) => {
    const p = players[socket.id];
    if (!p) return;
    p.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
    };
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) console.log(`${p.name} left`);
    delete players[socket.id];
    broadcastLobby();

    // If during a game, check win
    if (gameState === STATE.PLAYING) {
      const alive = Object.values(players).filter(pp => pp.alive);
      if (alive.length <= 1) {
        gameState = STATE.ENDED;
        const winner = alive[0] || null;
        io.emit('game:winner', winner ? { id: winner.id, name: winner.name, face: winner.face } : null);
        clearTimeout(gameEndTimer);
        gameEndTimer = setTimeout(returnToLobby, WIN_DISPLAY_MS);
      }
    }
  });
});

// Expose constants the client uses for rendering
app.get('/config.json', (_, res) => {
  res.json({
    ARENA_RADIUS,
    ARENA_CENTER,
    PLAYER_RADIUS,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🟢 Sumo Faces running on http://localhost:${PORT}`);
});
