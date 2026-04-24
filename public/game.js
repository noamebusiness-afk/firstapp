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
  const liveVideo = $('liveVideo');
  const snapCanvas = $('snapCanvas');
  const nameInput = $('nameInput');
  const snapBtn = $('snapBtn');
  const loginHint = $('loginHint');
  const playerGrid = $('playerGrid');
  const playerCount = $('playerCount');
  const startBtn = $('startBtn');
  const voiceList = $('voiceList');
  const muteBtn = $('muteBtn');
  const voiceStatus = $('voiceStatus');
  const gameCanvas = $('gameCanvas');
  const countdownEl = $('countdown');
  const winnerOverlay = $('winnerOverlay');
  const winnerFace = $('winnerFace');
  const winnerName = $('winnerName');
  const eliminatedBanner = $('eliminatedBanner');
  const aliveCount = $('aliveCount');
  const gameStatus = $('gameStatus');

  gameCanvas.setAttribute('tabindex', '0');

  // ---------- Screen switching ----------
  function show(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
    if (name === 'game') {
      gameCanvas.focus();
    }
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
      loginHint.textContent = 'המצלמה מוכנה. עשה פוזה.';
      snapBtn.disabled = false;
    } catch (err) {
      console.error('Camera error:', err);
      loginHint.textContent = 'המצלמה חסומה. אפשר גישה למצלמה ורענן.';
    }
  }

  function captureFaceCircleFrom(src) {
    const ctx = snapCanvas.getContext('2d');
    const size = snapCanvas.width; // 256
    ctx.clearRect(0, 0, size, size);

    const vw = src.videoWidth;
    const vh = src.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(src, sx, sy, side, side, 0, 0, size, size);
    ctx.restore();

    return snapCanvas.toDataURL('image/jpeg', 0.65);
  }

  function captureFaceCircle() {
    return captureFaceCircleFrom(video);
  }

  // ---------- Socket ----------
  const socket = io();
  let myId = null;
  let config = { ARENA_RADIUS: 400, ARENA_CENTER: { x: 500, y: 500 }, PLAYER_RADIUS: 40 };
  fetch('/config.json').then(r => r.json()).then(c => { config = c; });

  // ---------- Face cache ----------
  const faceData = new Map();   // id -> dataUrl (latest)
  const faceImgs = new Map();   // id -> HTMLImageElement

  function setFace(id, dataUrl) {
    faceData.set(id, dataUrl);
    if (faceImgs.has(id)) {
      faceImgs.get(id).src = dataUrl;
    } else {
      const img = new Image();
      img.src = dataUrl;
      faceImgs.set(id, img);
    }
  }

  function getFaceImg(id) {
    if (!faceImgs.has(id)) {
      const img = new Image();
      img.src = faceData.get(id) || '';
      faceImgs.set(id, img);
    }
    return faceImgs.get(id);
  }

  // ---------- Live face streaming ----------
  let faceStreamTimer = null;

  function startFaceStream() {
    if (faceStreamTimer) return;
    faceStreamTimer = setInterval(() => {
      const face = captureFaceCircleFrom(liveVideo);
      if (face) socket.emit('player:face_update', { face });
    }, 150);
  }

  socket.on('player:face_updated', ({ id, face }) => {
    setFace(id, face);
    const cardImg = playerGrid.querySelector(`[data-pid="${id}"] img`);
    if (cardImg) cardImg.src = face;
    const vpImg = voiceList && voiceList.querySelector(`[data-pid="${id}"] img`);
    if (vpImg) vpImg.src = face;
  });

  // ---------- Voice chat (WebRTC) ----------
  const peerConns = new Map(); // peerId -> RTCPeerConnection
  let localAudio = null;
  let voiceReady = null; // promise resolved when mic is ready
  let muted = false;

  function initVoice() {
    if (voiceReady) return voiceReady;
    voiceReady = navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then(stream => {
        localAudio = stream;
        if (voiceStatus) voiceStatus.textContent = 'מיק פעיל — דברו';
      })
      .catch(() => {
        if (voiceStatus) voiceStatus.textContent = 'אין גישה למיק';
      });
    return voiceReady;
  }

  async function makePeer(peerId, initiator) {
    if (peerConns.has(peerId)) return peerConns.get(peerId);
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    peerConns.set(peerId, pc);

    if (localAudio) {
      localAudio.getTracks().forEach(t => pc.addTrack(t, localAudio));
    }

    pc.onicecandidate = e => {
      if (e.candidate) socket.emit('webrtc:ice', { to: peerId, candidate: e.candidate });
    };

    pc.ontrack = e => {
      if (!pc._audio) {
        pc._audio = document.createElement('audio');
        pc._audio.autoplay = true;
        document.body.appendChild(pc._audio);
      }
      pc._audio.srcObject = e.streams[0];
      pc._audio.play().catch(() => {});
    };

    if (initiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc:offer', { to: peerId, offer });
      } catch (e) { console.warn('WebRTC offer error:', e); }
    }

    return pc;
  }

  socket.on('webrtc:offer', async ({ from, offer }) => {
    await initVoice(); // ensure mic ready before answering
    const pc = await makePeer(from, false);
    try {
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc:answer', { to: from, answer });
    } catch (e) { console.warn('WebRTC answer error:', e); }
  });

  socket.on('webrtc:answer', async ({ from, answer }) => {
    const pc = peerConns.get(from);
    if (pc) try { await pc.setRemoteDescription(answer); } catch {}
  });

  socket.on('webrtc:ice', async ({ from, candidate }) => {
    const pc = peerConns.get(from);
    if (pc) try { await pc.addIceCandidate(candidate); } catch {}
  });

  muteBtn && muteBtn.addEventListener('click', () => {
    muted = !muted;
    if (localAudio) localAudio.getAudioTracks().forEach(t => { t.enabled = !muted; });
    muteBtn.textContent = muted ? '🔇 בטל השתקה' : '🎤 השתק';
    muteBtn.classList.toggle('muted', muted);
    const myDot = voiceList && voiceList.querySelector(`[data-pid="${myId}"] .voice-player__dot`);
    if (myDot) myDot.classList.toggle('muted', muted);
  });

  // ---------- Joining ----------
  socket.on('player:joined', async ({ id, peerIds }) => {
    myId = id;
    show('lobby');

    // Hand off the camera stream to the hidden live-video element
    if (mediaStream) {
      liveVideo.srcObject = mediaStream;
      liveVideo.play().catch(() => {});
    }

    await initVoice();
    startFaceStream();

    // Initiate WebRTC connections to everyone already in the lobby
    for (const peerId of (peerIds || [])) {
      await makePeer(peerId, true);
    }
  });

  // ---------- Lobby state ----------
  socket.on('lobby:update', ({ players, state }) => {
    playerGrid.innerHTML = '';
    let myReady = false;
    players.forEach((p, index) => {
      if (p.face) setFace(p.id, p.face);
      if (p.id === myId && p.ready) myReady = true;
      const card = document.createElement('div');
      card.className = 'player-card' + (p.ready ? ' player-card--ready' : '');
      card.dataset.pid = p.id;
      card.innerHTML = `
        <div class="player-card__face"><img src="${faceData.get(p.id) || p.face || ''}" alt="${p.name}" /></div>
        <div class="player-card__name">${escapeHtml(p.name)}</div>
        ${p.id === myId ? '<div class="player-card__badge">YOU</div>' : ''}
        ${p.ready ? '<div class="player-card__ready">✓ מוכן</div>' : ''}
      `;
      card.style.animationDelay = `${(index * 0.4) % 2}s`;
      playerGrid.appendChild(card);
    });
    // Update ready button state
    if (myReady) {
      startBtn.disabled = true;
      startBtn.querySelector('.btn__text').textContent = 'ממתין לאחרים...';
    } else {
      startBtn.disabled = false;
      startBtn.querySelector('.btn__text').textContent = '✓ אני מוכן!';
    }
    playerCount.textContent = `${players.length} מתאבקים`;

    if (voiceList) {
      voiceList.innerHTML = '';
      players.forEach(p => {
        const el = document.createElement('div');
        el.className = 'voice-player';
        el.dataset.pid = p.id;
        el.innerHTML = `
          <div class="voice-player__face"><img src="${faceData.get(p.id) || p.face || ''}" alt="${p.name}" /></div>
          <div class="voice-player__name">${escapeHtml(p.name)}</div>
          <div class="voice-player__dot${p.id === myId ? ' you' : ''}"></div>
        `;
        voiceList.appendChild(el);
      });
    }

    if (state === 'lobby' && screens.game.classList.contains('active')) {
      show('lobby');
    }
  });

  // ---------- Login ----------
  snapBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      loginHint.textContent = 'בחר שם זירה קודם.';
      return;
    }
    const face = captureFaceCircle();
    if (!face) {
      loginHint.textContent = 'לא הצלחנו לצלם. נסה שוב.';
      return;
    }
    loginHint.textContent = 'נכנס לזירה...';
    snapBtn.disabled = true;
    socket.emit('player:join', { name, face });
  });

  startBtn.addEventListener('click', () => {
    socket.emit('player:ready');
    startBtn.disabled = true;
    startBtn.querySelector('.btn__text').textContent = 'ממתין לאחרים...';
    startBtn.blur();
  });

  // ---------- Game input ----------
  const inputState = { up: false, down: false, left: false, right: false };

  function setKey(key, down) {
    let changed = false;
    switch (key) {
      case 'w': case 'W': case 'ArrowUp':
        if (inputState.up !== down) { inputState.up = down; changed = true; } break;
      case 's': case 'S': case 'ArrowDown':
        if (inputState.down !== down) { inputState.down = down; changed = true; } break;
      case 'a': case 'A': case 'ArrowLeft':
        if (inputState.left !== down) { inputState.left = down; changed = true; } break;
      case 'd': case 'D': case 'ArrowRight':
        if (inputState.right !== down) { inputState.right = down; changed = true; } break;
    }
    if (changed) socket.emit('player:input', inputState);
  }

  window.addEventListener('keydown', e => {
    if (document.activeElement === nameInput) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
    setKey(e.key, true);
  });
  window.addEventListener('keyup', e => { setKey(e.key, false); });

  // Periodic input heartbeat so server always has latest state
  setInterval(() => {
    if (latest.state === 'playing') socket.emit('player:input', inputState);
  }, 100);

  // ---------- Game state / interpolation ----------
  let latest = { players: [], state: 'lobby' };
  let prev = { players: [], state: 'lobby' };
  let prevTime = 0;
  let latestTime = 0;
  const INTERP_DELAY = 100;

  socket.on('game:snapshot', snap => {
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
    gameStatus.textContent = 'התכוננו';
    winnerOverlay.classList.remove('show');
    eliminatedBanner.classList.remove('show');
  });
  socket.on('game:countdown_tick', ({ remaining }) => { showCountdown(remaining); });
  socket.on('game:start', () => {
    showCountdown('GO!');
    gameStatus.textContent = 'הילחמו!';
  });
  socket.on('game:eliminated', ({ id }) => {
    if (id === myId) {
      eliminatedBanner.classList.remove('show');
      void eliminatedBanner.offsetWidth;
      eliminatedBanner.classList.add('show');
    }
  });
  socket.on('game:winner', winner => {
    gameStatus.textContent = winner ? 'הקרב נגמר' : 'תיקו';
    if (winner) {
      winnerFace.src = faceData.get(winner.id) || '';
      winnerName.textContent = winner.name;
      winnerOverlay.classList.add('show');
    }
  });
  socket.on('game:to_lobby', () => {
    winnerOverlay.classList.remove('show');
    eliminatedBanner.classList.remove('show');
    show('lobby');
  });

  function showCountdown(value) {
    countdownEl.textContent = value;
    countdownEl.classList.remove('show');
    void countdownEl.offsetWidth;
    countdownEl.classList.add('show');
  }

  // ---------- Canvas rendering ----------
  const ctx = gameCanvas.getContext('2d');

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight - 70;
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
    let t = Math.max(0, Math.min(1, (renderTime - prevTime) / span));
    const prevMap = new Map(prev.players.map(p => [p.id, p]));
    return latest.players.map(p => {
      const pp = prevMap.get(p.id);
      if (!pp) return p;
      return { ...p, x: pp.x + (p.x - pp.x) * t, y: pp.y + (p.y - pp.y) * t };
    });
  }

  function render() {
    requestAnimationFrame(render);
    const w = gameCanvas.width / (window.devicePixelRatio || 1);
    const h = gameCanvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);

    // Account for the HUD bar that overlaps the top of the canvas
    const hudH = 58;
    const availH = h - hudH;
    const scale = Math.min(
      w / (config.ARENA_RADIUS * 2),
      availH / (config.ARENA_RADIUS * 2)
    ) * 0.97;
    const cx = w / 2;
    const cy = hudH + availH / 2;
    const toScreen = (wx, wy) => ({
      x: cx + (wx - config.ARENA_CENTER.x) * scale,
      y: cy + (wy - config.ARENA_CENTER.y) * scale,
    });

    drawArena(cx, cy, config.ARENA_RADIUS * scale);

    const players = interpolate();
    const sorted = [...players].sort((a, b) => Number(a.alive) - Number(b.alive));
    for (const p of sorted) {
      const { x, y } = toScreen(p.x, p.y);
      drawPlayer(p, x, y, config.PLAYER_RADIUS * scale);
    }

    drawFruits(latest.fruits || [], toScreen, scale);

    aliveCount.textContent = players.filter(p => p.alive).length;
  }

  function drawArena(cx, cy, r) {
    const t = performance.now() / 1000;
    ctx.save();

    // Dark halo outside the ring
    ctx.beginPath();
    ctx.arc(cx, cy, r + 34, 0, Math.PI * 2);
    ctx.fillStyle = '#04050d';
    ctx.fill();

    // Arena floor — dark clay with gold spotlight
    const floor = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    floor.addColorStop(0, '#2e1c0e');
    floor.addColorStop(0.55, '#1c1008');
    floor.addColorStop(1, '#0a0603');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = floor;
    ctx.fill();

    // Central spotlight
    const spot = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.7);
    spot.addColorStop(0, 'rgba(233,185,73,0.14)');
    spot.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = spot;
    ctx.fill();

    // Faint cross guides
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    // Center marker glow
    ctx.shadowColor = '#e9b949';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.028, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(233,185,73,0.6)';
    ctx.fill();
    ctx.shadowBlur = 0;

    // Neon ring — layered glow strokes
    const glowLayers = [[18, 0.06], [10, 0.14], [5, 0.45], [2, 1]];
    for (const [lw, alpha] of glowLayers) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(79,194,160,${alpha})`;
      ctx.lineWidth = lw;
      ctx.stroke();
    }

    // Pulsing LED dots around the ring
    const numLeds = 40;
    const ledColors = ['#d1334a', '#4fc2a0', '#e9b949'];
    for (let i = 0; i < numLeds; i++) {
      const angle = (i / numLeds) * Math.PI * 2;
      const pulse = 0.55 + 0.45 * Math.sin(t * 2.2 + i * 0.72);
      const lx = cx + Math.cos(angle) * (r + 20);
      const ly = cy + Math.sin(angle) * (r + 20);
      const col = ledColors[i % 3];
      ctx.shadowColor = col;
      ctx.shadowBlur = 10;
      ctx.globalAlpha = pulse;
      ctx.beginPath();
      ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  function drawPlayer(p, x, y, r) {
    ctx.save();

    const sc = p.alive ? 1 : Math.max(0.05, p.fallScale ?? 1);
    const rot = p.alive ? 0 : (p.fallRotation ?? 0);

    // Grow with sizeBonus (fruits)
    const renderR = r * (1 + (p.sizeBonus || 0) * 0.2);

    // Head wobble when moving
    const t = performance.now() / 1000;
    const speed = Math.hypot(p.vx || 0, p.vy || 0);
    const moving = p.alive && speed > 0.35;
    const phase = t * Math.max(speed, 1) * 4;
    const wobble = moving ? Math.sin(phase) * renderR * 0.08 : 0;

    ctx.translate(x + wobble, y);
    ctx.rotate(rot);
    ctx.scale(sc, sc);

    const ring = p.id === myId ? '#e9b949' : '#f4ecd8';

    // Shadow
    if (p.alive) {
      ctx.beginPath();
      ctx.ellipse(0, renderR + 6, renderR * 0.75, renderR * 0.18, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
    }

    // Head ring glow
    if (p.id === myId) { ctx.shadowColor = '#e9b949'; ctx.shadowBlur = 14; }
    ctx.beginPath();
    ctx.arc(0, 0, renderR + 4, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Face image (or dog emoji for bot)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, renderR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (p.isBot) {
      ctx.fillStyle = '#1a3a1a';
      ctx.fillRect(-renderR, -renderR, renderR * 2, renderR * 2);
      ctx.font = `${renderR * 1.4}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🐕', 0, 0);
    } else {
      const img = getFaceImg(p.id);
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, -renderR, -renderR, renderR * 2, renderR * 2);
      } else {
        ctx.fillStyle = '#2a2f6b';
        ctx.fillRect(-renderR, -renderR, renderR * 2, renderR * 2);
      }
    }
    ctx.restore();

    // Head border
    ctx.beginPath();
    ctx.arc(0, 0, renderR, 0, Math.PI * 2);
    ctx.strokeStyle = '#0f1020';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Topknot
    if (!p.isBot) {
      ctx.beginPath();
      ctx.ellipse(0, -renderR - 6, renderR * 0.14, renderR * 0.24, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1205';
      ctx.fill();
    }

    // Name above head
    if (p.alive && sc > 0.5) {
      const fs = Math.max(10, renderR * 0.32);
      ctx.font = `bold ${fs}px 'Bungee', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = p.name.toUpperCase();
      const ly = -renderR - (p.isBot ? 4 : 14);
      ctx.strokeStyle = '#0f1020';
      ctx.lineWidth = 4;
      ctx.strokeText(label, 0, ly);
      ctx.fillStyle = p.isBot ? '#4fc2a0' : '#f4ecd8';
      ctx.fillText(label, 0, ly);
    }

    ctx.restore();
  }

  function drawFruits(fruits, toScreen, scale) {
    const fs = Math.round(18 * scale * 2.2);
    for (const f of fruits) {
      const { x, y } = toScreen(f.x, f.y);
      ctx.save();
      ctx.shadowColor = 'rgba(255, 220, 80, 0.8)';
      ctx.shadowBlur = 10;
      ctx.font = `${fs}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.type, x, y);
      ctx.restore();
    }
  }

  render();

  // ---------- Virtual joystick (touch) ----------
  const joystickBase = $('joystickBase');
  const joystickThumb = $('joystickThumb');
  const JOY_RADIUS = 55;  // max thumb travel in px
  const JOY_DEAD = 14;    // dead-zone in px
  let activeTouchId = null;
  let joyOriginX = 0;
  let joyOriginY = 0;

  function applyJoy(dx, dy) {
    inputState.up    = dy < -JOY_DEAD;
    inputState.down  = dy >  JOY_DEAD;
    inputState.left  = dx < -JOY_DEAD;
    inputState.right = dx >  JOY_DEAD;
    socket.emit('player:input', inputState);

    // Move thumb visually (clamped to circle)
    const dist = Math.hypot(dx, dy);
    const clamp = Math.min(dist, JOY_RADIUS);
    const angle = Math.atan2(dy, dx);
    const tx = Math.cos(angle) * clamp;
    const ty = Math.sin(angle) * clamp;
    joystickThumb.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
  }

  function joyReset() {
    activeTouchId = null;
    joystickBase.classList.remove('active');
    joystickThumb.style.transform = 'translate(-50%, -50%)';
    inputState.up = inputState.down = inputState.left = inputState.right = false;
    socket.emit('player:input', inputState);
  }

  gameCanvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (activeTouchId !== null) return;
    const t = e.changedTouches[0];
    activeTouchId = t.identifier;
    joyOriginX = t.clientX;
    joyOriginY = t.clientY;
    // Position base under finger (centered)
    joystickBase.style.left = (t.clientX - 65) + 'px';
    joystickBase.style.top  = (t.clientY - 65) + 'px';
    joystickBase.classList.add('active');
  }, { passive: false });

  gameCanvas.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === activeTouchId) {
        applyJoy(t.clientX - joyOriginX, t.clientY - joyOriginY);
      }
    }
  }, { passive: false });

  gameCanvas.addEventListener('touchend', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === activeTouchId) joyReset();
    }
  }, { passive: false });

  gameCanvas.addEventListener('touchcancel', e => {
    e.preventDefault();
    joyReset();
  }, { passive: false });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ---------- Toast notifications ----------
  let activeToast = null;
  function showToast(msg) {
    if (activeToast) { activeToast.remove(); activeToast = null; }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    activeToast = el;
    setTimeout(() => {
      if (activeToast === el) { el.remove(); activeToast = null; }
    }, 2500);
  }

  socket.on('fruit:eaten', ({ fruitType, message }) => {
    showToast(`${fruitType} ${message}`);
  });

  socket.on('tzofi:bark', () => {
    showToast('🐕 וואף וואף! אני צופי!');
  });

  // ---------- Boot ----------
  show('login');
  initCamera();
})();
