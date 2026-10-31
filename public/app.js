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
let localVideo = null;

// Botão = ícone do Tabler + texto (só strings fixas, nunca dados de usuários)
function setBtn(el, icon, text) {
  el.innerHTML = `<i class="ti ti-${icon}"></i><span>${text}</span>`;
}

/* ---------- Lobby ---------- */

const params = new URLSearchParams(location.search);
$('#nameInput').value = localStorage.getItem('name') || '';
$('#roomInput').value = params.get('room') || randomRoom();

function randomRoom() {
  return Math.random().toString(36).slice(2, 8);
}

if (params.get('room')) {
  $('#invited').hidden = false;
  $('#invited span').textContent = `Você vai entrar na sala ${$('#roomInput').value}`;
}
$('#shuffleRoom').onclick = () => {
  $('#roomInput').value = randomRoom();
  $('#roomInput').focus();
};

// Celulares não conseguem compartilhar a tela, mas podem entrar para assistir
const canShare = !!navigator.mediaDevices?.getDisplayMedia;
if (!canShare) {
  $('#shareBtn').hidden = true;
  $('.quality').hidden = true;
}

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  myName = $('#nameInput').value.trim();
  roomId = $('#roomInput').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!myName || !roomId) return;
  localStorage.setItem('name', myName);
  // criado aqui, dentro do clique, para o navegador permitir o áudio
  try {
    audioCtx = new AudioContext();
  } catch {}
  join();
});

function showError(msg) {
  const el = $('#lobbyError');
  el.textContent = msg;
  el.hidden = false;
}

// Identidade desta aba: sobrevive a recarregar a página, mas não é compartilhada entre abas
function tabId() {
  try {
    let id = sessionStorage.getItem('cid');
    if (!id) sessionStorage.setItem('cid', (id = Math.random().toString(36).slice(2) + Date.now().toString(36)));
    return id;
  } catch {
    return '';
  }
}

async function join() {
  if (ws && ws.readyState <= WebSocket.OPEN) return; // evita entrar duas vezes (duplo clique)
  // Servidor de sinalização: o configurado em config.js ou o mesmo domínio da página
  const base = (window.SIGNAL_URL || location.origin).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/ice`);
    if (res.ok) iceServers = await res.json();
  } catch {}

  ws = new WebSocket(base.replace(/^http/, 'ws'));
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: roomId, name: myName, cid: tabId() }));
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
    case 'replaced':
      // esta aba foi substituída por outra igual (ex.: página recarregada)
      ws.onclose = null;
      ws.close();
      alert('Você entrou nesta sala em outra janela.');
      location.href = location.pathname;
      break;
    case 'joined':
      myId = msg.id;
      $('#lobby').hidden = true;
      $('#app').hidden = false;
      $('#roomName').textContent = roomId;
      history.pushState(null, '', `?room=${roomId}`); // o "voltar" do navegador sai da sala
      msg.peers.forEach((p) => createPeer(p.id, p.name));
      renderMembers();
      break;
    case 'peer-joined': {
      const existing = peers.get(msg.id);
      if (existing) existing.name = msg.name;
      else createPeer(msg.id, msg.name);
      renderMembers();
      if (micOn) broadcast({ type: 'mic-state', on: true }); // quem chegou agora fica sabendo
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
      else if (msg.data.type === 'mic-state' && peers.has(msg.from)) {
        peers.get(msg.from).micOn = !!msg.data.on;
        renderMembers();
      }
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
    micOn: false, // estado do microfone dessa pessoa (avisado por ela)
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

// Mostra um tile só quando o stream tem vídeo (tela). Streams só com áudio (microfone) ficam ocultos
// e alimentam o indicador de quem está falando.
function renderStream(peer, entry) {
  const hasVideo = entry.stream.getVideoTracks().length > 0;
  const meterKey = `${peer.id}:${entry.stream.id}`;

  if (hasVideo && !entry.tile) {
    entry.tile = makeTile(peer.name, entry.video, { remote: true });
    $('#grid').appendChild(entry.tile);
  } else if (!hasVideo && entry.tile) {
    entry.tile.remove();
    entry.tile = null;
    $('#sink').appendChild(entry.video);
  }

  if (!hasVideo && entry.stream.getAudioTracks().length) addMeter(meterKey, peer.id, entry.stream);
  else removeMeter(meterKey);

  renderMembers();
}

function dropStream(peer, streamId) {
  const entry = peer?.streams.get(streamId);
  if (!entry) return;
  removeMeter(`${peer.id}:${streamId}`);
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
    setBtn(mute, 'volume', 'Silenciar');
    mute.onclick = () => {
      video.muted = !video.muted;
      video.muted ? setBtn(mute, 'volume-off', 'Ativar som') : setBtn(mute, 'volume', 'Silenciar');
    };
    tools.appendChild(mute);
  }

  // Clicar na tela entra e sai da tela cheia
  const isFull = () => document.fullscreenElement === tile;
  const toggleFull = () => (isFull() ? document.exitFullscreen() : tile.requestFullscreen?.());
  const full = document.createElement('button');
  full.className = 'btn';
  setBtn(full, 'arrows-maximize', 'Tela cheia');
  full.onclick = toggleFull;
  tools.appendChild(full);
  tile.appendChild(tools);

  video.onclick = toggleFull;
  tile.onfullscreenchange = () =>
    isFull() ? setBtn(full, 'arrows-minimize', 'Sair da tela cheia') : setBtn(full, 'arrows-maximize', 'Tela cheia');
  return tile;
}

/* ---------- Compartilhar tela ---------- */

$('#shareBtn').onclick = () => (screenStream ? stopShare() : startShare());
$('#switchBtn').onclick = switchShare;

function captureConstraints() {
  const q = QUALITY[$('#quality').value];
  return {
    video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps } },
    audio: true, // áudio do sistema/aba, se o navegador oferecer
  };
}

async function pickScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(captureConstraints());
    const [track] = stream.getVideoTracks();
    track.contentHint = 'motion';
    track.onended = stopShare; // botão "Parar compartilhamento" do navegador
    return stream;
  } catch (err) {
    if (err.name !== 'NotAllowedError') alert('Não foi possível compartilhar a tela: ' + err.message);
    return null; // cancelou o seletor
  }
}

async function startShare() {
  const stream = await pickScreen();
  if (!stream) return;
  screenStream = stream;

  localVideo = document.createElement('video');
  localVideo.autoplay = true;
  localVideo.muted = true; // não ouvir o próprio áudio
  localVideo.playsInline = true;
  localVideo.srcObject = screenStream;
  localTile = makeTile(`${myName} (você)`, localVideo, { remote: false });
  $('#grid').appendChild(localTile);

  for (const { pc } of peers.values()) screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));

  setBtn($('#shareBtn'), 'screen-share-off', 'Parar de compartilhar');
  $('#shareBtn').classList.replace('primary', 'danger');
  $('#switchBtn').hidden = false;
  renderMembers();
}

// Troca a tela/janela sem parar a transmissão: o mesmo stream continua e quem assiste não vê corte.
async function switchShare() {
  if (!screenStream) return;
  const next = await pickScreen();
  if (!next) return;

  const cur = screenStream;
  const [oldVideo] = cur.getVideoTracks();
  const [oldAudio] = cur.getAudioTracks();
  const [newVideo] = next.getVideoTracks();
  const [newAudio] = next.getAudioTracks();

  oldVideo.onended = null;
  for (const { pc } of peers.values()) {
    const senders = pc.getSenders();
    await senders.find((s) => s.track === oldVideo)?.replaceTrack(newVideo);
    const audioSender = oldAudio && senders.find((s) => s.track === oldAudio);
    if (oldAudio && newAudio) await audioSender?.replaceTrack(newAudio);
    else if (oldAudio && audioSender) pc.removeTrack(audioSender);
    else if (newAudio) pc.addTrack(newAudio, cur);
  }

  cur.removeTrack(oldVideo);
  oldAudio && cur.removeTrack(oldAudio);
  oldVideo.stop();
  oldAudio?.stop();
  cur.addTrack(newVideo);
  newAudio && cur.addTrack(newAudio);

  localVideo.srcObject = null;
  localVideo.srcObject = cur;
  for (const { pc } of peers.values()) applyBitrate(pc);
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
  localTile = localVideo = null;
  setBtn($('#shareBtn'), 'screen-share', 'Compartilhar tela');
  $('#shareBtn').classList.replace('danger', 'primary');
  $('#switchBtn').hidden = true;
  renderMembers();
}

// Mudar a qualidade durante a transmissão
$('#quality').onchange = async () => {
  if (!screenStream) return;
  const { video } = captureConstraints();
  try {
    await screenStream.getVideoTracks()[0].applyConstraints(video);
  } catch {}
  for (const { pc } of peers.values()) applyBitrate(pc);
};

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
    addMeter('me', 'me', micStream);
    micOn = true;
  } else {
    micOn = !micOn;
  }
  micStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
  setBtn($('#micBtn'), micOn ? 'microphone' : 'microphone-off', 'Microfone');
  $('#micBtn').classList.toggle('on', micOn);
  broadcast({ type: 'mic-state', on: micOn });
  renderMembers();
};

/* ---------- Quem está falando ---------- */

let audioCtx = null;
const meters = new Map(); // chave -> { owner, source, analyser, buf, lastLoud }
const speaking = new Set(); // ids de quem está falando agora ('me' = eu)

function addMeter(key, owner, stream) {
  if (!audioCtx || meters.has(key) || !stream.getAudioTracks().length) return;
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  meters.set(key, { owner, source, analyser, buf: new Uint8Array(analyser.fftSize), lastLoud: 0 });
  audioCtx.state === 'suspended' && audioCtx.resume();
}

function removeMeter(key) {
  const m = meters.get(key);
  if (!m) return;
  m.source.disconnect();
  meters.delete(key);
}

setInterval(() => {
  const now = performance.now();
  const active = new Set();
  for (const m of meters.values()) {
    m.analyser.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) sum += ((v - 128) / 128) ** 2;
    if (Math.sqrt(sum / m.buf.length) > 0.02) m.lastLoud = now;
    if (now - m.lastLoud < 300) active.add(m.owner); // segura 300ms para não piscar
  }
  const changed = active.size !== speaking.size || [...active].some((id) => !speaking.has(id));
  if (changed) {
    speaking.clear();
    active.forEach((id) => speaking.add(id));
    paintSpeaking();
  }
}, 80);

function paintSpeaking() {
  document.querySelectorAll('#members li').forEach((li) => li.classList.toggle('speaking', speaking.has(li.dataset.id)));
}

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
    { id: 'me', name: `${myName} (você)`, mic: micOn, sharing: !!screenStream },
    ...[...peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      mic: p.micOn,
      sharing: [...p.streams.values()].some((s) => s.tile),
    })),
  ];
  for (const m of everyone) {
    const li = document.createElement('li');
    li.dataset.id = m.id;
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = colorFor(m.name);
    av.textContent = m.name[0]?.toUpperCase() || '?';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name;
    li.append(av, name);
    if (!m.mic) {
      const muted = document.createElement('i');
      muted.className = 'ti ti-microphone-off mute-icon';
      muted.title = 'Microfone desligado';
      li.appendChild(muted);
    }
    if (m.sharing) {
      const live = document.createElement('span');
      live.className = 'live';
      live.innerHTML = '<i class="ti ti-broadcast"></i>AO VIVO';
      li.appendChild(live);
    }
    list.appendChild(li);
  }
  $('#count').textContent = everyone.length;
  paintSpeaking();
}

/* ---------- Convite / sair ---------- */

$('#copyLink').onclick = async () => {
  const url = `${location.origin}/?room=${roomId}`;
  try {
    await navigator.clipboard.writeText(url);
    setBtn($('#copyLink'), 'check', 'Copiado!');
  } catch {
    prompt('Copie o link:', url);
  }
  setTimeout(() => setBtn($('#copyLink'), 'copy', 'Copiar convite'), 1500);
};

// Sair volta para a tela inicial, já com o código desta sala (fácil de entrar de novo)
$('#leaveBtn').onclick = () => {
  if (ws) ws.onclose = null;
  location.href = `${location.pathname}?room=${encodeURIComponent(roomId)}`;
};

// Botão "voltar" do navegador também sai da sala
window.addEventListener('popstate', () => {
  if ($('#app').hidden) return;
  if (ws) ws.onclose = null;
  location.reload();
});

window.addEventListener('pagehide', () => ws?.close());
