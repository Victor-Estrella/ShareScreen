// Servidor de sinalização + arquivos estáticos.
// O vídeo/áudio NÃO passa por aqui: vai direto entre os navegadores (WebRTC).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PEERS_PER_ROOM = 8; // malha completa: cada pessoa envia o vídeo para todas as outras
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Servidores STUN/TURN. Para redes difíceis (4G, CGNAT, firewall corporativo)
// defina TURN_URL, TURN_USER e TURN_PASS no ambiente.
function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  return list;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ice') {
    // CORS: a página (Vercel) fica em outro domínio que este servidor (Render)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(iceServers()));
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map(); // roomId -> Map(peerId -> ws)

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function leave(ws) {
  const { room, id } = ws;
  if (!room) return;
  const members = rooms.get(room);
  if (!members) return;
  members.delete(id);
  for (const other of members.values()) send(other, { type: 'peer-left', id });
  if (members.size === 0) rooms.delete(room);
  ws.room = null;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join' && !ws.room) {
      const room = String(msg.room || '').trim().toLowerCase().slice(0, 40);
      const name = String(msg.name || 'Anônimo').trim().slice(0, 24) || 'Anônimo';
      if (!room) return;
      let members = rooms.get(room);
      if (!members) rooms.set(room, (members = new Map()));
      if (members.size >= MAX_PEERS_PER_ROOM) return send(ws, { type: 'full' });

      ws.id = crypto.randomUUID().slice(0, 8);
      ws.name = name;
      ws.room = room;
      const peers = [...members.values()].map((p) => ({ id: p.id, name: p.name }));
      members.set(ws.id, ws);
      send(ws, { type: 'joined', id: ws.id, peers });
      for (const other of members.values()) {
        if (other !== ws) send(other, { type: 'peer-joined', id: ws.id, name });
      }
      return;
    }

    if (!ws.room) return;
    const members = rooms.get(ws.room);
    if (!members) return;

    if (msg.type === 'signal') {
      const target = members.get(msg.to);
      if (target) send(target, { type: 'signal', from: ws.id, data: msg.data });
    } else if (msg.type === 'broadcast') {
      for (const other of members.values()) {
        if (other !== ws) send(other, { type: 'broadcast', from: ws.id, data: msg.data });
      }
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// Remove conexões mortas
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`ShareScreen rodando em http://localhost:${PORT}`);
});
