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
      loginHint.textContent = 'Camera ready. Strike a pose.';
      snapBtn.disabled = false;
    } catch (err) {
      console.error('Camera error:', err);
      loginHint.textContent = 'Camera blocked. Please allow webcam access and reload.';
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
        if (voiceStatus) voiceStatus.textContent = 'MIC LIVE — SPEAK UP';
      })
      .catch(() => {
        if (voiceStatus) voiceStatus.textContent = 'NO MIC ACCESS';
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
    muteBtn.textContent = muted ? '🔇 UNMUTE' : '🎤 MUTE';
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
    players.forEach(p => {
      if (p.face) setFace(p.id, p.face);
      const card = document.createElement('div');
      card.className = 'player-card';
      card.dataset.pid = p.id;
      card.innerHTML = `
        <div class="player-card__face"><img src="${faceData.get(p.id) || p.face || ''}" alt="${p.name}" /></div>
        <div class="player-card__name">${escapeHtml(p.name)}</div>
        ${p.id === myId ? '<div class="player-card__badge">YOU</div>' : ''}
      `;
      playerGrid.appendChild(card);
    });
    playerCount.textContent = `${players.length} rikishi`;

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
    gameStatus.textContent = 'GET READY';
    winnerOverlay.classList.remove('show');
    eliminatedBanner.classList.remove('show');
  });
  socket.on('game:countdown_tick', ({ remaining }) => { showCountdown(remaining); });
  socket.on('game:start', () => {
    showCountdown('GO!');
    gameStatus.textContent = 'FIGHT';
  });
  socket.on('game:eliminated', ({ id }) => {
    if (id === myId) {
      eliminatedBanner.classList.remove('show');
      void eliminatedBanner.offsetWidth;
      eliminatedBanner.classList.add('show');
    }
  });
  socket.on('game:winner', winner => {
    gameStatus.textContent = winner ? 'BOUT OVER' : 'DRAW';
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

    aliveCount.textContent = players.filter(p => p.alive).length;
  }

  function drawArena(cx, cy, r) {
    ctx.save();

    ctx.beginPath();
    ctx.arc(cx, cy, r + 14, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0b1a';
    ctx.fill();

    const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    grad.addColorStop(0, '#e8c9a0');
    grad.addColorStop(0.7, '#c9a678');
    grad.addColorStop(1, '#9c7b4e');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.lineWidth = Math.max(3, r * 0.02);
    ctx.strokeStyle = '#f4ecd8';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.04, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15,16,32,0.35)';
    ctx.fill();

    ctx.strokeStyle = 'rgba(15,16,32,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();

    ctx.restore();
  }

  // Draw a chibi sumo doll: topknot → head (face) → neck → body → mawashi → arms → legs
  function drawPlayer(p, x, y, r) {
    const img = getFaceImg(p.id);
    ctx.save();

    const sc = p.alive ? 1 : Math.max(0.05, p.fallScale ?? 1);
    const rot = p.alive ? 0 : (p.fallRotation ?? 0);

    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(sc, sc);

    const bodyR = r * 1.6;
    const bodyY = r + bodyR * 0.75;
    const skin = p.id === myId ? '#dba96a' : '#ecc080';
    const belt = p.id === myId ? '#e9b949' : '#d1334a';
    const ring = p.id === myId ? '#e9b949' : '#f4ecd8';

    // Ground shadow
    if (p.alive) {
      ctx.beginPath();
      ctx.ellipse(0, bodyY + bodyR + r * 0.12, bodyR * 0.9, r * 0.16, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fill();
    }

    // Legs
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * bodyR * 0.37, bodyY + bodyR * 0.68, r * 0.3, r * 0.44, 0, 0, Math.PI * 2);
      ctx.fillStyle = skin;
      ctx.fill();
      ctx.strokeStyle = '#0f1020';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Body
    ctx.beginPath();
    ctx.arc(0, bodyY, bodyR, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.strokeStyle = '#0f1020';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Mawashi belt (clipped to body)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, bodyY, bodyR, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = belt;
    ctx.fillRect(-bodyR, bodyY - bodyR * 0.4, bodyR * 2, bodyR * 0.8);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(0, bodyY, bodyR, 0, Math.PI * 2);
    ctx.strokeStyle = '#0f1020';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Arms
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * (bodyR + r * 0.3), bodyY - bodyR * 0.1, r * 0.36, r * 0.26, s * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = skin;
      ctx.fill();
      ctx.strokeStyle = '#0f1020';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Neck
    ctx.beginPath();
    ctx.ellipse(0, r * 0.84, r * 0.36, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();

    // Head ring (gold for me, cream for others)
    ctx.beginPath();
    ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();

    // Face image clipped to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, -r, -r, r * 2, r * 2);
    } else {
      ctx.fillStyle = '#2a2f6b';
      ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#0f1020';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Topknot (chonmage)
    ctx.beginPath();
    ctx.ellipse(0, -r - 7, r * 0.15, r * 0.26, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1205';
    ctx.fill();

    // Name label below body
    if (p.alive && sc > 0.5) {
      const fs = Math.max(11, r * 0.3);
      ctx.font = `bold ${fs}px 'Bungee', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = p.name.toUpperCase();
      const ly = bodyY + bodyR + 6;
      ctx.strokeStyle = '#0f1020';
      ctx.lineWidth = 4;
      ctx.strokeText(label, 0, ly);
      ctx.fillStyle = '#f4ecd8';
      ctx.fillText(label, 0, ly);
    }

    ctx.restore();
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

  // ---------- Boot ----------
  show('login');
  initCamera();
})();
