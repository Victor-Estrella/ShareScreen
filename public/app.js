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
let micGain = null; // GainNode do meu microfone
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
  document.documentElement.classList.remove('rejoining'); // não conseguiu voltar: mostra a tela de entrada
  setBusy(false);
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

// Rodando em localhost / rede local (ex.: celular acessando o IP do PC): usa o servidor local
const isLocalHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);

// Botão "Entrar" ocupado enquanto conecta (o servidor gratuito do Render pode demorar a acordar)
function setBusy(on, text = 'Entrando…') {
  const b = $('#joinForm button[type="submit"]');
  b.disabled = on;
  on ? setBtn(b, 'loader-2', text) : setBtn(b, 'door-enter', 'Entrar na sala');
  b.querySelector('.ti')?.classList.toggle('spin', on);
}

// Voltando para a sala (F5 ou queda) e o servidor ainda está reiniciando/acordando: tenta de novo sozinho
let rejoinTries = 0;
function joinFailed() {
  if (document.documentElement.classList.contains('rejoining') && rejoinTries < 20) {
    rejoinTries++;
    setTimeout(join, 4000);
    return;
  }
  showError('Não foi possível conectar ao servidor.');
}

let joining = false; // há uma tentativa de entrada em andamento (inclui a espera pelo servidor acordar)

async function join() {
  // Só uma tentativa por vez. O flag vale também durante o fetch abaixo, que no Render pode levar
  // dezenas de segundos: sem ele, cliques repetidos criavam vários WebSockets ao mesmo tempo.
  if (joining || (ws && ws.readyState <= WebSocket.OPEN)) return;
  joining = true;
  $('#lobbyError').hidden = true;
  setBusy(true);

  try {
    // Servidor de sinalização: o configurado em config.js (produção) ou o mesmo domínio da página
    const base = (isLocalHost ? location.origin : window.SIGNAL_URL || location.origin).replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/ice`);
      if (res.ok) iceServers = await res.json();
    } catch {}

    // Os handlers usam `sock` (este socket), nunca a variável global `ws`, que pode apontar para outro
    const sock = new WebSocket(base.replace(/^http/, 'ws'));
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: 'join', room: roomId, name: myName, cid: tabId() }));
    sock.onmessage = (e) => sock === ws && onServerMessage(JSON.parse(e.data));
    sock.onerror = () => sock === ws && joinFailed();
    sock.onclose = () => {
      // conexão caiu com a sala aberta: recarrega, e o app volta para a mesma sala sozinho
      if (sock === ws && !$('#app').hidden) location.reload();
    };
  } catch (err) {
    console.error(err);
    joinFailed();
  } finally {
    joining = false; // a partir daqui a proteção é o readyState do socket
  }
}

const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const signal = (to, data) => send({ type: 'signal', to, data });
const broadcast = (data) => send({ type: 'broadcast', data });

function onServerMessage(msg) {
  switch (msg.type) {
    case 'full':
      ws.onclose = null;
      ws.close();
      clearSession();
      showError('Essa sala está cheia.');
      break;
    case 'replaced':
      // esta aba foi substituída por outra igual (ex.: aba duplicada)
      ws.onclose = null;
      ws.close();
      clearSession();
      alert('Você entrou nesta sala em outra janela.');
      location.href = location.pathname;
      break;
    case 'joined':
      myId = msg.id;
      saveSession(); // atualizar a página (F5) volta para esta sala
      document.documentElement.classList.remove('rejoining');
      $('#lobby').hidden = true;
      $('#app').hidden = false;
      $('#roomName').textContent = roomId;
      history.pushState(null, '', `?room=${roomId}`); // o "voltar" do navegador sai da sala
      msg.peers.forEach((p) => createPeer(p.id, p.name));
      renderMembers();
      break;
    case 'peer-joined': {
      const existing = peers.get(msg.id);
      if (existing) {
        existing.name = msg.name;
        applyPeerVolumes(existing); // o volume salvo é por nome
      } else createPeer(msg.id, msg.name);
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
    video.play?.().catch(() => needUnlock()); // autoplay bloqueado (ex.: após atualizar a página)
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
    entry.tile = makeTile(peer.name, entry.video, { remote: true, peer });
    $('#grid').appendChild(entry.tile);
  } else if (!hasVideo && entry.tile) {
    entry.tile.remove();
    entry.tile = null;
    $('#sink').appendChild(entry.video);
  }

  if (!hasVideo && entry.stream.getAudioTracks().length) addMeter(meterKey, peer.id, entry.stream);
  else removeMeter(meterKey);

  applyPeerVolumes(peer);
  renderMembers();
}

function dropStream(peer, streamId) {
  const entry = peer?.streams.get(streamId);
  if (!entry) return;
  removeMeter(`${peer.id}:${streamId}`);
  dropAudioRoute(entry);
  entry.tile?.remove();
  entry.video.srcObject = null;
  entry.video.remove();
  peer.streams.delete(streamId);
  renderMembers();
}

function makeTile(label, video, { remote, peer }) {
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
    // Volume: botão aqui, ou botão direito / toque longo em qualquer parte da tela
    const volBtn = document.createElement('button');
    volBtn.className = 'btn';
    setBtn(volBtn, 'volume', 'Volume');
    volBtn.onclick = () => {
      const r = volBtn.getBoundingClientRect();
      openMenu(r.left, r.bottom + 6, peerMenu(peer));
    };
    tools.appendChild(volBtn);
    bindMenu(tile, () => peerMenu(peer));
  }

  // Dois modos:
  //  - Ampliar: esta tela ocupa sozinha o espaço de todas (como se só uma pessoa transmitisse)
  //  - Tela cheia: o navegador inteiro mostra só esta tela
  const isFull = () => document.fullscreenElement === tile;
  const toggleFull = () => (isFull() ? document.exitFullscreen() : tile.requestFullscreen?.());
  const toggleFocus = () => setFocus(focusedTile === tile ? null : tile);

  const focus = document.createElement('button');
  focus.className = 'btn focus-btn'; // escondido via CSS quando só há uma tela
  tile._focusBtn = focus;
  focus.onclick = toggleFocus;
  tools.appendChild(focus);
  setBtn(focus, 'arrows-diagonal', 'Ampliar');

  const full = document.createElement('button');
  full.className = 'btn';
  setBtn(full, 'arrows-maximize', 'Tela cheia');
  full.onclick = toggleFull;
  tools.appendChild(full);
  tile.appendChild(tools);

  // Clique = ampliar/reduzir (ou sair da tela cheia). Duplo clique = tela cheia.
  // O clique simples espera um instante para não disparar junto com o duplo clique.
  let clickTimer = null;
  video.onclick = () => {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      isFull() ? document.exitFullscreen() : toggleFocus();
    }, 220);
  };
  video.ondblclick = () => {
    clearTimeout(clickTimer);
    clickTimer = null;
    toggleFull();
  };

  tile.onfullscreenchange = () =>
    isFull() ? setBtn(full, 'arrows-minimize', 'Sair da tela cheia') : setBtn(full, 'arrows-maximize', 'Tela cheia');
  return tile;
}

// Modo "ampliar": só o tile escolhido aparece, ocupando toda a área
let focusedTile = null;

function setFocus(tile) {
  focusedTile = tile;
  $('#grid').classList.toggle('has-focus', !!tile);
  document.querySelectorAll('#grid .tile').forEach((t) => {
    const on = t === tile;
    t.classList.toggle('focused', on);
    if (t._focusBtn) on ? setBtn(t._focusBtn, 'arrows-diagonal-minimize-2', 'Reduzir') : setBtn(t._focusBtn, 'arrows-diagonal', 'Ampliar');
  });
}

// Se a tela ampliada some (parou de compartilhar / saiu), volta para a grade
// (ou se sobrou só uma tela: ampliar não faz sentido e esconderia a próxima transmissão que chegar)
new MutationObserver(() => {
  if (focusedTile && (!focusedTile.isConnected || $('#grid').querySelectorAll('.tile').length < 2)) setFocus(null);
}).observe($('#grid'), { childList: true });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && focusedTile && !document.fullscreenElement && !menuEl) setFocus(null);
});

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
    let raw;
    try {
      raw = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      alert('Não foi possível acessar o microfone: ' + err.message);
      return;
    }
    // O microfone passa por um controle de ganho (0–200%) antes de ser enviado
    micStream = raw;
    if (audioCtx) {
      try {
        await audioCtx.resume();
        micGain = audioCtx.createGain();
        micGain.gain.value = vol.get('self', 100) / 100;
        const dest = audioCtx.createMediaStreamDestination();
        audioCtx.createMediaStreamSource(raw).connect(micGain);
        micGain.connect(dest);
        micStream = dest.stream;
      } catch (err) {
        console.error(err);
        micStream = raw;
      }
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
    li.title = 'Botão direito (ou segure) para ajustar o volume';
    bindMenu(li, () => (m.id === 'me' ? selfMenu() : peers.has(m.id) ? peerMenu(peers.get(m.id)) : null));
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
function leaveRoom() {
  clearSession(); // sair de verdade: o F5 não deve te trazer de volta
  if (ws) ws.onclose = null;
  location.href = `${location.pathname}?room=${encodeURIComponent(roomId)}`;
}

// Modal de confirmação
let modalReturnFocus = null;

function openLeaveModal() {
  const modal = $('#leaveModal');
  if (!modal.hidden) return;
  closeMenu();
  document.fullscreenElement && document.exitFullscreen(); // o modal não apareceria em tela cheia
  const lines = ['Você vai sair da chamada.'];
  if (screenStream) lines.push('Sua transmissão será encerrada.');
  $('#leaveText').textContent = lines.join(' ');
  modalReturnFocus = document.activeElement;
  modal.hidden = false;
  $('#leaveCancel').focus(); // a opção segura vem focada
}

function closeLeaveModal() {
  $('#leaveModal').hidden = true;
  modalReturnFocus?.focus?.();
}

$('#leaveBtn').onclick = openLeaveModal;
$('#leaveConfirm').onclick = leaveRoom;
$('#leaveCancel').onclick = closeLeaveModal;
$('#leaveModal').addEventListener('pointerdown', (e) => e.target === e.currentTarget && closeLeaveModal()); // clicar fora
$('#leaveModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeLeaveModal();
  if (e.key !== 'Tab') return;
  // mantém o foco dentro do modal
  const first = $('#leaveCancel');
  const last = $('#leaveConfirm');
  if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
  else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
});

// Botão "voltar" do navegador também pede confirmação (fica na sala até confirmar)
window.addEventListener('popstate', () => {
  if ($('#app').hidden) return;
  history.pushState(null, '', location.href);
  openLeaveModal();
});

window.addEventListener('pagehide', () => ws?.close());

/* ---------- Volume: botão direito / toque longo ---------- */

// Volumes lembrados neste navegador (por nome da pessoa)
const vol = {
  get(key, def = 100) {
    try {
      const v = localStorage.getItem('vol:' + key);
      return v == null ? def : Number(v);
    } catch {
      return def;
    }
  },
  set(key, v) {
    try {
      localStorage.setItem('vol:' + key, String(v));
    } catch {}
  },
};

// Voz (stream só com áudio) e transmissão (stream com vídeo) têm volumes separados
// O volume de um <video>/<audio> não passa de 100%. Para aumentar até 200%, o áudio de quem chega
// passa por um GainNode do WebAudio (e o elemento fica mudo, só puxando o stream).
// Se o WebAudio ainda não está liberado (aba sem clique), usa o volume normal do elemento (até 100%).
function ensureAudioRoute(entry) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const track = entry.stream.getAudioTracks()[0];
  if (!track) return dropAudioRoute(entry);
  if (entry.routedTrack === track) return;
  dropAudioRoute(entry);
  try {
    const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
    const gain = audioCtx.createGain();
    source.connect(gain);
    gain.connect(audioCtx.destination);
    entry.route = { source, gain };
    entry.gain = gain;
    entry.routedTrack = track;
    entry.video.muted = true;
  } catch (err) {
    console.error(err);
  }
}

function dropAudioRoute(entry) {
  if (entry.route) {
    entry.route.source.disconnect();
    entry.route.gain.disconnect();
  }
  entry.route = entry.gain = entry.routedTrack = null;
  entry.video.muted = false;
}

function applyPeerVolumes(peer) {
  if (audioCtx && !audioCtx.onstatechange) {
    // quando o áudio for liberado (primeiro clique), passa tudo para o amplificador
    audioCtx.onstatechange = () => audioCtx.state === 'running' && peers.forEach((p) => applyPeerVolumes(p));
  }
  for (const entry of peer.streams.values()) {
    ensureAudioRoute(entry);
    const isScreen = entry.stream.getVideoTracks().length > 0;
    const v = vol.get(`${isScreen ? 'stream' : 'voice'}:${peer.name}`) / 100;
    if (entry.gain) entry.gain.gain.value = v;
    else entry.video.volume = Math.min(v, 1);
  }
}

function peerMenu(peer) {
  const rows = [
    {
      label: 'Voz',
      icons: ['microphone', 'microphone-off'],
      value: vol.get(`voice:${peer.name}`),
      max: 200, // acima de 100% amplifica (útil se a pessoa fala baixo)
      onChange: (v) => {
        vol.set(`voice:${peer.name}`, v);
        applyPeerVolumes(peer);
      },
    },
  ];
  if ([...peer.streams.values()].some((s) => s.tile)) {
    rows.push({
      label: 'Transmissão',
      icons: ['volume', 'volume-off'],
      value: vol.get(`stream:${peer.name}`),
      max: 200,
      onChange: (v) => {
        vol.set(`stream:${peer.name}`, v);
        applyPeerVolumes(peer);
      },
    });
  }
  return { title: peer.name, rows };
}

function selfMenu() {
  return {
    title: 'Meu microfone',
    rows: [
      {
        label: 'Volume de saída',
        icons: ['microphone', 'microphone-off'],
        value: vol.get('self', 100),
        max: 200, // dá para aumentar se você fala baixo
        onChange: (v) => {
          vol.set('self', v);
          if (micGain) micGain.gain.value = v / 100;
        },
      },
    ],
  };
}

let menuEl = null;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
  document.removeEventListener('pointerdown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey);
  window.removeEventListener('resize', closeMenu);
}
const onMenuOutside = (e) => menuEl && !menuEl.contains(e.target) && closeMenu();
const onMenuKey = (e) => e.key === 'Escape' && closeMenu();

function openMenu(x, y, { title, rows }) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'vol-menu';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `Volume: ${title}`);

  const head = document.createElement('div');
  head.className = 'vol-title';
  head.textContent = title;
  el.appendChild(head);
  rows.forEach((r) => el.appendChild(volRow(r)));

  // em tela cheia só o elemento em tela cheia aparece, então o menu vai dentro dele
  (document.fullscreenElement || document.body).appendChild(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;

  menuEl = el;
  document.addEventListener('pointerdown', onMenuOutside, true);
  document.addEventListener('keydown', onMenuKey);
  window.addEventListener('resize', closeMenu);
}

function volRow({ label, icons, value, max, onChange }) {
  const row = document.createElement('div');
  row.className = 'vol-row';

  const top = document.createElement('div');
  top.className = 'vol-top';
  const name = document.createElement('span');
  name.textContent = label;
  const pct = document.createElement('span');
  pct.className = 'vol-pct';
  top.append(name, pct);

  const ctl = document.createElement('div');
  ctl.className = 'vol-ctl';
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'icon-btn';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = 0;
  range.max = max;
  range.step = 1;
  range.value = Math.min(value, max);
  range.setAttribute('aria-label', `Volume: ${label}`);

  let last = +range.value > 0 ? +range.value : 100; // volume para voltar ao tirar o mudo
  const paint = () => {
    const v = +range.value;
    pct.textContent = v === 0 ? 'Mudo' : `${v}%`;
    mute.innerHTML = `<i class="ti ti-${v === 0 ? icons[1] : icons[0]}"></i>`;
    mute.classList.toggle('is-muted', v === 0);
    mute.title = v === 0 ? 'Ativar som' : 'Silenciar';
    mute.setAttribute('aria-label', mute.title);
    range.style.setProperty('--fill', `${(v / max) * 100}%`);
  };
  const set = (v) => {
    range.value = v;
    if (v > 0) last = v;
    paint();
    onChange(v);
  };
  range.oninput = () => set(+range.value);
  mute.onclick = () => set(+range.value > 0 ? 0 : last);
  paint();

  ctl.append(mute, range);
  row.append(top, ctl);
  return row;
}

// Abre o menu com botão direito (mouse) ou segurando ~0,5s (celular/tablet)
function bindMenu(el, getMenu) {
  const open = (x, y) => {
    const m = getMenu();
    if (m) openMenu(x, y, m);
  };
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    open(e.clientX, e.clientY);
  });

  let timer = null;
  let fired = false;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener(
    'touchstart',
    (e) => {
      cancel();
      fired = false;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      timer = setTimeout(() => {
        fired = true;
        navigator.vibrate?.(15);
        open(sx, sy);
      }, 500);
    },
    { passive: true }
  );
  el.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) cancel(); // virou rolagem
    },
    { passive: true }
  );
  el.addEventListener(
    'touchend',
    (e) => {
      cancel();
      if (fired) {
        e.preventDefault(); // não deixa o toque virar clique (tela cheia / ligar microfone)
        fired = false;
      }
    },
    { passive: false }
  );
  el.addEventListener('touchcancel', cancel);
}

bindMenu($('#micBtn'), selfMenu);

/* ---------- Atualizar a página (F5) mantém você na sala ---------- */

function saveSession() {
  try {
    sessionStorage.setItem('session', JSON.stringify({ room: roomId, name: myName }));
  } catch {}
}
function clearSession() {
  try {
    sessionStorage.removeItem('session');
  } catch {}
}

// Depois de recarregar, o navegador pode deixar o áudio suspenso até a primeira interação.
// Libera sozinho, sem aviso, no primeiro clique ou tecla.
function armSilentUnlock() {
  const events = ['pointerdown', 'keydown'];
  const go = () => {
    audioCtx?.resume();
    peers.forEach((p) => p.streams.forEach((s) => s.video.play().catch(() => {})));
    events.forEach((t) => document.removeEventListener(t, go, true));
  };
  events.forEach((t) => document.addEventListener(t, go, true));
}

// O aviso só aparece se o navegador bloquear de verdade o som/vídeo de alguém (play() rejeitado).
let unlockBanner = null;
function needUnlock() {
  if (unlockBanner) return;
  unlockBanner = document.createElement('button');
  unlockBanner.type = 'button';
  unlockBanner.className = 'unlock';
  unlockBanner.innerHTML = '<i class="ti ti-volume"></i><span>Clique aqui para ativar o som e o vídeo</span>';
  document.body.appendChild(unlockBanner);

  const go = () => {
    audioCtx?.resume();
    peers.forEach((p) => p.streams.forEach((s) => s.video.play().catch(() => {})));
    unlockBanner?.remove();
    unlockBanner = null;
    document.removeEventListener('pointerdown', go, true);
  };
  document.addEventListener('pointerdown', go, true);
}

// Se esta aba já estava numa sala (e o endereço é o da mesma sala), volta para ela sozinho
(function autoRejoin() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem('session') || 'null');
  } catch {}
  const urlRoom = (params.get('room') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!saved || !saved.name || saved.room !== urlRoom) {
    document.documentElement.classList.remove('rejoining');
    return;
  }

  myName = saved.name;
  roomId = saved.room;
  try {
    audioCtx = new AudioContext(); // sem clique pode ficar suspenso
    if (audioCtx.state === 'suspended') armSilentUnlock();
  } catch {}
  join();
})();

/* ---------- Sinal de vida (mantém o servidor acordado) ---------- */
// Hospedagens gratuitas (Render) suspendem o servidor depois de ~15 min sem tráfego recebido.
// Enquanto você está numa sala, manda uma mensagem mínima a cada 25s para isso não acontecer.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && !$('#app').hidden) send({ type: 'ping' });
}, 25000);
