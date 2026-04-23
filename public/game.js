// game.js — Sumo Faces client
(() => {
  'use strict';

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const screens = {
    login: $('screen-login'),
    lobby: $('screen-lobby'),
    game: $('screen-game'),
  };
  const video = $('video');
  const snapCanvas = $('snapCanvas');
  const nameInput = $('nameInput');
  const snapBtn = $('snapBtn');
  const loginHint = $('loginHint');
  const playerGrid = $('playerGrid');
  const playerCount = $('playerCount');
  const startBtn = $('startBtn');
  const chatMessages = $('chatMessages');
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const gameCanvas = $('gameCanvas');
  const countdownEl = $('countdown');
  const winnerOverlay = $('winnerOverlay');
  const winnerFace = $('winnerFace');
  const winnerName = $('winnerName');
  const eliminatedBanner = $('eliminatedBanner');
  const aliveCount = $('aliveCount');
  const gameStatus = $('gameStatus');

  // ---------- Screen switching ----------
  function show(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
  }

  // ---------- Webcam ----------
  let mediaStream = null;
  async function initCamera() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      video.srcObject = mediaStream;
      await video.play();
      loginHint.textContent = 'Camera ready. Strike a pose.';
      snapBtn.disabled = false;
    } catch (err) {
      console.error('Camera error:', err);
      loginHint.textContent = 'Camera blocked. Please allow webcam access and reload.';
      snapBtn.disabled = true;
    }
  }

  // Capture current video frame, crop to circle on transparent background, return base64 PNG
  function captureFaceCircle() {
    const ctx = snapCanvas.getContext('2d');
    const size = snapCanvas.width; // 256
    ctx.clearRect(0, 0, size, size);

    // Use the smaller video dimension to crop a square from the middle
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;

    // Circular mask
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    // Mirror horizontally to match user's reflection in the video preview
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
    ctx.restore();

    return snapCanvas.toDataURL('image/png');
  }

  // ---------- Socket ----------
  const socket = io();
  let myId = null;
  let config = { ARENA_RADIUS: 400, ARENA_CENTER: { x: 500, y: 500 }, PLAYER_RADIUS: 40 };

  fetch('/config.json').then(r => r.json()).then(c => { config = c; });

  socket.on('player:joined', ({ id }) => {
    myId = id;
    show('lobby');
    // Release the camera once we have the snapshot
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
  });

  // ---------- Lobby state ----------
  const faceCache = new Map(); // id -> HTMLImageElement

  function ensureFaceImage(id, dataUrl) {
    if (faceCache.has(id)) return faceCache.get(id);
    const img = new Image();
    img.src = dataUrl;
    faceCache.set(id, img);
    return img;
  }

  socket.on('lobby:update', ({ players, state }) => {
    // Render player grid
    playerGrid.innerHTML = '';
    players.forEach(p => {
      ensureFaceImage(p.id, p.face);
      const card = document.createElement('div');
      card.className = 'player-card';
      card.innerHTML = `
        <div class="player-card__face"><img src="${p.face}" alt="${p.name}" /></div>
        <div class="player-card__name">${escapeHtml(p.name)}</div>
        ${p.id === myId ? '<div class="player-card__badge">YOU</div>' : ''}
      `;
      playerGrid.appendChild(card);
    });
    playerCount.textContent = `${players.length} rikishi`;

    if (state === 'lobby' && screens.game.classList.contains('active')) {
      show('lobby');
    }
  });

  // ---------- Chat ----------
  chatForm.addEventListener('submit', e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    chatInput.value = '';
  });

  socket.on('chat:message', ({ id, name, face, text }) => {
    ensureFaceImage(id, face);
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `
      <div class="chat-msg__face"><img src="${face}" alt="" /></div>
      <div class="chat-msg__body">
        <div class="chat-msg__name">${escapeHtml(name)}</div>
        <div class="chat-msg__text">${escapeHtml(text)}</div>
      </div>
    `;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg--system';
    el.innerHTML = `<div class="chat-msg__body"><div class="chat-msg__text">★ ${escapeHtml(text)}</div></div>`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ---------- Login ----------
  nameInput.addEventListener('input', () => {
    // no-op; button stays enabled once camera is ready
  });

  snapBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      loginHint.textContent = 'Pick a ring name first.';
      return;
    }
    const face = captureFaceCircle();
    if (!face) {
      loginHint.textContent = 'Could not grab a frame. Try again.';
      return;
    }
    loginHint.textContent = 'Entering the ring…';
    snapBtn.disabled = true;
    socket.emit('player:join', { name, face });
  });

  startBtn.addEventListener('click', () => {
    socket.emit('game:start_request');
  });

  // ---------- Game input ----------
  const input = { up: false, down: false, left: false, right: false };
  let lastInputSent = 0;

  function setKey(key, down) {
    let changed = false;
    switch (key) {
      case 'w': case 'W': case 'ArrowUp':
        if (input.up !== down) { input.up = down; changed = true; } break;
      case 's': case 'S': case 'ArrowDown':
        if (input.down !== down) { input.down = down; changed = true; } break;
      case 'a': case 'A': case 'ArrowLeft':
        if (input.left !== down) { input.left = down; changed = true; } break;
      case 'd': case 'D': case 'ArrowRight':
        if (input.right !== down) { input.right = down; changed = true; } break;
    }
    if (changed) sendInput();
  }

  function sendInput() {
    const now = Date.now();
    if (now - lastInputSent < 30) return; // basic throttle
    lastInputSent = now;
    socket.emit('player:input', input);
  }

  window.addEventListener('keydown', e => {
    // Don't trap arrows while typing
    if (document.activeElement === chatInput || document.activeElement === nameInput) return;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
    setKey(e.key, true);
  });
  window.addEventListener('keyup', e => {
    setKey(e.key, false);
  });

  // ---------- Game state / interpolation ----------
  let latest = { players: [], state: 'lobby' };
  let prev = { players: [], state: 'lobby' };
  let prevTime = 0;
  let latestTime = 0;
  const INTERP_DELAY = 100; // ms behind most recent snapshot

  socket.on('game:snapshot', (snap) => {
    prev = latest;
    prevTime = latestTime;
    latest = snap;
    latestTime = performance.now();
    if (screens.lobby.classList.contains('active') &&
        (snap.state === 'countdown' || snap.state === 'playing')) {
      show('game');
    }
  });

  socket.on('game:countdown_start', ({ seconds }) => {
    show('game');
    showCountdown(seconds);
    gameStatus.textContent = 'GET READY';
    winnerOverlay.classList.remove('show');
    eliminatedBanner.classList.remove('show');
  });
  socket.on('game:countdown_tick', ({ remaining }) => {
    showCountdown(remaining);
  });
  socket.on('game:start', () => {
    showCountdown('GO!', true);
    gameStatus.textContent = 'FIGHT';
  });
  socket.on('game:eliminated', ({ id, name }) => {
    if (id === myId) {
      eliminatedBanner.classList.remove('show');
      void eliminatedBanner.offsetWidth;
      eliminatedBanner.classList.add('show');
    }
    // System msg in lobby chat (visible when they return)
    addSystemMessage(`${name} was pushed out of the ring`);
  });
  socket.on('game:winner', (winner) => {
    gameStatus.textContent = winner ? 'BOUT OVER' : 'DRAW';
    if (winner) {
      winnerFace.src = faceCache.get(winner.id)?.src || '';
      winnerName.textContent = winner.name;
      winnerOverlay.classList.add('show');
    }
  });
  socket.on('game:to_lobby', () => {
    winnerOverlay.classList.remove('show');
    eliminatedBanner.classList.remove('show');
    show('lobby');
  });

  function showCountdown(value, big) {
    countdownEl.textContent = value;
    countdownEl.classList.remove('show');
    // Trigger reflow to restart animation
    void countdownEl.offsetWidth;
    countdownEl.classList.add('show');
  }

  // ---------- Canvas rendering ----------
  const ctx = gameCanvas.getContext('2d');

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight - 70; // minus header
    gameCanvas.width = w * dpr;
    gameCanvas.height = h * dpr;
    gameCanvas.style.width = w + 'px';
    gameCanvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function interpolate() {
    const now = performance.now();
    const renderTime = now - INTERP_DELAY;

    if (!prev.players.length || !latest.players.length) return latest.players;
    const span = latestTime - prevTime;
    if (span <= 0) return latest.players;
    let t = (renderTime - prevTime) / span;
    t = Math.max(0, Math.min(1, t));

    // Build a map of prev by id
    const prevMap = new Map(prev.players.map(p => [p.id, p]));
    return latest.players.map(p => {
      const pp = prevMap.get(p.id);
      if (!pp) return p;
      return {
        ...p,
        x: pp.x + (p.x - pp.x) * t,
        y: pp.y + (p.y - pp.y) * t,
      };
    });
  }

  function render() {
    requestAnimationFrame(render);
    const w = gameCanvas.width / (window.devicePixelRatio || 1);
    const h = gameCanvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);

    // Compute viewport: scale so the arena fits with some margin
    const margin = 80;
    const scale = Math.min(
      (w - margin) / (config.ARENA_RADIUS * 2),
      (h - margin) / (config.ARENA_RADIUS * 2)
    );
    const cx = w / 2;
    const cy = h / 2;
    const toScreen = (wx, wy) => ({
      x: cx + (wx - config.ARENA_CENTER.x) * scale,
      y: cy + (wy - config.ARENA_CENTER.y) * scale,
    });

    // Arena ring
    drawArena(cx, cy, config.ARENA_RADIUS * scale);

    // Players (dead render below alive)
    const players = interpolate();
    const sorted = [...players].sort((a, b) => Number(a.alive) - Number(b.alive));
    for (const p of sorted) {
      const { x, y } = toScreen(p.x, p.y);
      drawPlayer(p, x, y, config.PLAYER_RADIUS * scale);
    }

    // Update HUD
    const aliveN = players.filter(p => p.alive).length;
    aliveCount.textContent = aliveN;
  }

  function drawArena(cx, cy, r) {
    // Outer shadow ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + 14, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0b1a';
    ctx.fill();

    // Dohyō (clay ring) — tan/sand
    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    grad.addColorStop(0, '#e8c9a0');
    grad.addColorStop(0.7, '#c9a678');
    grad.addColorStop(1, '#9c7b4e');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Inner border ring (white rope, shimenawa vibe)
    ctx.lineWidth = Math.max(3, r * 0.02);
    ctx.strokeStyle = '#f4ecd8';
    ctx.stroke();

    // Center marker
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.04, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15,16,32,0.35)';
    ctx.fill();

    // Cross guides (faint)
    ctx.strokeStyle = 'rgba(15,16,32,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    ctx.restore();
  }

  function drawPlayer(p, x, y, r) {
    const img = faceCache.get(p.id);
    ctx.save();

    const scale = p.alive ? 1 : Math.max(0.05, p.fallScale ?? 1);
    const rot = p.alive ? 0 : (p.fallRotation ?? 0);

    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);

    // Shadow below
    if (p.alive) {
      ctx.beginPath();
      ctx.ellipse(0, r * 0.9, r * 0.85, r * 0.25, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
    }

    // Ring around face
    ctx.beginPath();
    ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = p.id === myId ? '#e9b949' : '#f4ecd8';
    ctx.fill();

    // Face circle (clipped image)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img && img.complete) {
      ctx.drawImage(img, -r, -r, r * 2, r * 2);
    } else {
      ctx.fillStyle = '#2a2f6b';
      ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    ctx.restore();

    // Name label
    if (p.alive && scale > 0.5) {
      ctx.fillStyle = '#f4ecd8';
      ctx.strokeStyle = '#0f1020';
      ctx.lineWidth = 4;
      ctx.font = `bold ${Math.max(11, r * 0.32)}px 'Bungee', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = p.name.toUpperCase();
      ctx.strokeText(label, 0, r + 10);
      ctx.fillText(label, 0, r + 10);
    }

    ctx.restore();
  }

  render();

  // ---------- Boot ----------
  show('login');
  initCamera();
})();
