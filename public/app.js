// Cliente WebRTC em malha (mesh): cada pessoa mantém uma conexão com todas as outras.
// Usa o padrão "perfect negotiation" para permitir adicionar/remover tracks a qualquer momento.
const $ = (s) => document.querySelector(s);

const QUALITY = {
  '720p30': { w: 1280, h: 720, fps: 30, bitrate: 2_500_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 5_000_000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 8_000_000 },
};

let ws;
let myId = null;
let myName = '';
let roomId = '';
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

const peers = new Map(); // id -> { id, name, pc, polite, makingOffer, ignoreOffer, streams: Map }
let screenStream = null;
let micStream = null;
let micOn = false;
let localTile = null;

/* ---------- Lobby ---------- */

const params = new URLSearchParams(location.search);
$('#nameInput').value = localStorage.getItem('name') || '';
$('#roomInput').value = params.get('room') || randomRoom();

function randomRoom() {
  return Math.random().toString(36).slice(2, 8);
}

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return showError('Seu navegador não suporta compartilhamento de tela, ou a página não está em HTTPS/localhost.');
  }
  myName = $('#nameInput').value.trim();
  roomId = $('#roomInput').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!myName || !roomId) return;
  localStorage.setItem('name', myName);
  join();
});

function showError(msg) {
  const el = $('#lobbyError');
  el.textContent = msg;
  el.hidden = false;
}

async function join() {
  // Servidor de sinalização: o configurado em config.js ou o mesmo domínio da página
  const base = (window.SIGNAL_URL || location.origin).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/ice`);
    if (res.ok) iceServers = await res.json();
  } catch {}

  ws = new WebSocket(base.replace(/^http/, 'ws'));
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: roomId, name: myName }));
  ws.onmessage = (e) => onServerMessage(JSON.parse(e.data));
  ws.onerror = () => showError('Não foi possível conectar ao servidor.');
  ws.onclose = () => {
    if (!$('#app').hidden) {
      alert('Conexão com o servidor perdida.');
      location.reload();
    }
  };
}

const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const signal = (to, data) => send({ type: 'signal', to, data });
const broadcast = (data) => send({ type: 'broadcast', data });

function onServerMessage(msg) {
  switch (msg.type) {
    case 'full':
      ws.onclose = null;
      ws.close();
      showError('Essa sala está cheia.');
      break;
    case 'joined':
      myId = msg.id;
      $('#lobby').hidden = true;
      $('#app').hidden = false;
      $('#roomName').textContent = roomId;
      history.replaceState(null, '', `?room=${roomId}`);
      msg.peers.forEach((p) => createPeer(p.id, p.name));
      renderMembers();
      break;
    case 'peer-joined': {
      const existing = peers.get(msg.id);
      if (existing) existing.name = msg.name;
      else createPeer(msg.id, msg.name);
      renderMembers();
      break;
    }
    case 'peer-left':
      removePeer(msg.id);
      break;
    case 'signal':
      onSignal(msg.from, msg.data);
      break;
    case 'broadcast':
      if (msg.data.type === 'share-stopped') dropStream(peers.get(msg.from), msg.data.streamId);
      break;
  }
}

/* ---------- Conexões entre pessoas ---------- */

function createPeer(id, name) {
  const pc = new RTCPeerConnection({ iceServers });
  const peer = {
    id,
    name,
    pc,
    polite: myId > id, // um lado cede em caso de colisão de ofertas
    makingOffer: false,
    ignoreOffer: false,
    streams: new Map(), // streamId -> { stream, video, tile }
  };
  peers.set(id, peer);

  pc.onicecandidate = (e) => e.candidate && signal(id, { candidate: e.candidate });

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      signal(id, { description: pc.localDescription });
    } catch (err) {
      console.error(err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.ontrack = ({ streams: [stream] }) => stream && attachRemote(peer, stream);

  pc.onsignalingstatechange = () => {
    if (pc.signalingState === 'stable') applyBitrate(pc);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  // quem entra depois já recebe o que estou transmitindo
  for (const s of [screenStream, micStream]) {
    s?.getTracks().forEach((t) => pc.addTrack(t, s));
  }
  return peer;
}

async function onSignal(from, { description, candidate }) {
  const peer = peers.get(from) || createPeer(from, '...');
  const pc = peer.pc;
  try {
    if (description) {
      const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        signal(from, { description: pc.localDescription });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!peer.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error(err);
  }
}

function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  [...peer.streams.keys()].forEach((sid) => dropStream(peer, sid));
  peer.pc.close();
  peers.delete(id);
  renderMembers();
}

/* ---------- Mídia recebida ---------- */

function attachRemote(peer, stream) {
  let entry = peer.streams.get(stream.id);
  if (!entry) {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    $('#sink').appendChild(video); // toca o áudio mesmo sem tile
    entry = { stream, video, tile: null };
    peer.streams.set(stream.id, entry);
    stream.onaddtrack = stream.onremovetrack = () => renderStream(peer, entry);
  }
  renderStream(peer, entry);
}

// Mostra um tile só quando o stream tem vídeo (tela). Streams só com áudio (microfone) ficam ocultos.
function renderStream(peer, entry) {
  const hasVideo = entry.stream.getVideoTracks().length > 0;
  if (hasVideo && !entry.tile) {
    entry.tile = makeTile(`${peer.name}`, entry.video, { remote: true });
    $('#grid').appendChild(entry.tile);
  } else if (!hasVideo && entry.tile) {
    entry.tile.remove();
    entry.tile = null;
    $('#sink').appendChild(entry.video);
  }
  renderMembers();
}

function dropStream(peer, streamId) {
  const entry = peer?.streams.get(streamId);
  if (!entry) return;
  entry.tile?.remove();
  entry.video.srcObject = null;
  entry.video.remove();
  peer.streams.delete(streamId);
  renderMembers();
}

function makeTile(label, video, { remote }) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.appendChild(video);

  const tag = document.createElement('div');
  tag.className = 'label';
  tag.textContent = label;
  tile.appendChild(tag);

  const tools = document.createElement('div');
  tools.className = 'tools';
  if (remote) {
    const mute = document.createElement('button');
    mute.className = 'btn';
    mute.textContent = 'Silenciar';
    mute.onclick = () => {
      video.muted = !video.muted;
      mute.textContent = video.muted ? 'Ativar som' : 'Silenciar';
    };
    tools.appendChild(mute);
  }
  const full = document.createElement('button');
  full.className = 'btn';
  full.textContent = 'Tela cheia';
  full.onclick = () => tile.requestFullscreen?.();
  tools.appendChild(full);
  tile.appendChild(tools);

  video.ondblclick = () => tile.requestFullscreen?.();
  return tile;
}

/* ---------- Compartilhar tela ---------- */

$('#shareBtn').onclick = () => (screenStream ? stopShare() : startShare());

async function startShare() {
  const q = QUALITY[$('#quality').value];
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps } },
      audio: true, // áudio do sistema/aba, se o navegador oferecer
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') alert('Não foi possível compartilhar a tela: ' + err.message);
    return;
  }

  const [track] = screenStream.getVideoTracks();
  track.contentHint = 'motion';
  track.onended = stopShare; // botão "Parar compartilhamento" do navegador

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true; // não ouvir o próprio áudio
  video.playsInline = true;
  video.srcObject = screenStream;
  localTile = makeTile(`${myName} (você)`, video, { remote: false });
  $('#grid').appendChild(localTile);

  for (const { pc } of peers.values()) screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));

  $('#shareBtn').textContent = 'Parar de compartilhar';
  $('#shareBtn').classList.replace('primary', 'danger');
  $('#quality').disabled = true;
  renderMembers();
}

function stopShare() {
  if (!screenStream) return;
  const stream = screenStream;
  screenStream = null;

  for (const { pc } of peers.values()) {
    pc.getSenders().forEach((s) => s.track && stream.getTracks().includes(s.track) && pc.removeTrack(s));
  }
  stream.getTracks().forEach((t) => {
    t.onended = null;
    t.stop();
  });
  broadcast({ type: 'share-stopped', streamId: stream.id });

  localTile?.remove();
  localTile = null;
  $('#shareBtn').textContent = 'Compartilhar tela';
  $('#shareBtn').classList.replace('danger', 'primary');
  $('#quality').disabled = false;
  renderMembers();
}

function applyBitrate(pc) {
  const q = QUALITY[$('#quality').value];
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    if (p.encodings[0].maxBitrate === q.bitrate) continue;
    p.encodings[0].maxBitrate = q.bitrate;
    sender.setParameters(p).catch(() => {});
  }
}

/* ---------- Microfone ---------- */

$('#micBtn').onclick = async () => {
  if (!micStream) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      alert('Não foi possível acessar o microfone: ' + err.message);
      return;
    }
    for (const { pc } of peers.values()) micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
    micOn = true;
  } else {
    micOn = !micOn;
  }
  micStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  $('#micBtn').textContent = `Microfone: ${micOn ? 'ligado' : 'desligado'}`;
  $('#micBtn').classList.toggle('on', micOn);
};

/* ---------- Lista de pessoas ---------- */

function colorFor(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

function renderMembers() {
  const list = $('#members');
  list.replaceChildren();
  const everyone = [
    { name: `${myName} (você)`, sharing: !!screenStream },
    ...[...peers.values()].map((p) => ({
      name: p.name,
      sharing: [...p.streams.values()].some((s) => s.tile),
    })),
  ];
  for (const m of everyone) {
    const li = document.createElement('li');
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = colorFor(m.name);
    av.textContent = m.name[0]?.toUpperCase() || '?';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name;
    li.append(av, name);
    if (m.sharing) {
      const live = document.createElement('span');
      live.className = 'live';
      live.textContent = 'AO VIVO';
      li.appendChild(live);
    }
    list.appendChild(li);
  }
  $('#count').textContent = everyone.length;
}

/* ---------- Convite / sair ---------- */

$('#copyLink').onclick = async () => {
  const url = `${location.origin}/?room=${roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    $('#copyLink').textContent = 'Copiado!';
  } catch {
    prompt('Copie o link:', url);
  }
  setTimeout(() => ($('#copyLink').textContent = 'Copiar convite'), 1500);
};

$('#leaveBtn').onclick = () => {
  if (ws) ws.onclose = null;
  location.href = '/';
};

window.addEventListener('beforeunload', () => ws?.close());
