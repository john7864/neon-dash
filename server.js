'use strict';
// NEON DASH — serveur statique + multijoueur temps réel (WebSocket écrit à la main,
// modules natifs uniquement : http, fs, path, crypto — zéro dépendance).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const PORT = parseInt(arg('--port') || process.env.PORT || '7100', 10);
const HOST = arg('--host') || process.env.HOST || '0.0.0.0';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8'
};

/* ================= Classement (persisté dans scores.json) ================= */

const SCORES_FILE = path.join(ROOT, 'scores.json');
const MAX_ENTRIES = 50;
let scores = {}; // { levelKey: { name: 'NOM DU NIVEAU', entries: [{name,pct,time,coins,date}] } }

try {
  const raw = fs.readFileSync(SCORES_FILE, 'utf8');
  const d = JSON.parse(raw);
  if (d && typeof d === 'object' && !Array.isArray(d)) scores = d;
} catch (e) { /* pas encore de scores */ }

let saveTimer = null;
function saveScores() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(SCORES_FILE, JSON.stringify(scores), (err) => {
      if (err) console.error('scores.json — écriture impossible :', err.message);
    });
  }, 500);
}

// Meilleure entrée par pseudo : remplace si % supérieur, ou % égal et temps inférieur.
function betterThan(a, b) {
  if (a.pct !== b.pct) return a.pct > b.pct;
  const at = typeof a.time === 'number' ? a.time : Infinity;
  const bt = typeof b.time === 'number' ? b.time : Infinity;
  if (at !== bt) return at < bt;
  return a.coins > b.coins;
}

function submitScore(lvlKey, lvlName, entry) {
  if (!scores[lvlKey]) scores[lvlKey] = { name: lvlName, entries: [] };
  const board = scores[lvlKey];
  board.name = lvlName;
  const idx = board.entries.findIndex((e) => e.name === entry.name);
  if (idx >= 0) {
    if (!betterThan(entry, board.entries[idx])) return false;
    board.entries[idx] = entry;
  } else {
    board.entries.push(entry);
  }
  board.entries.sort((a, b) => (betterThan(a, b) ? -1 : 1));
  if (board.entries.length > MAX_ENTRIES) board.entries.length = MAX_ENTRIES;
  saveScores();
  return true;
}

/* ================= Catalogue de niveaux publics (persisté dans levels.json) ================= */

const LEVELS_FILE = path.join(ROOT, 'levels.json');
const MAX_LEVELS = 300;
const OBJ_T = {
  spike: 1, spikeCeil: 1, block: 1, pad: 1, padCeil: 1, saw: 1,
  portalCube: 1, portalShip: 1, portalGravDown: 1, portalGravUp: 1, coin: 1, gate: 1,
  orb: 1, orbGrav: 1, portalWave: 1, speedSlow: 1, speedNormal: 1, speedFast: 1
};
let pubLevels = []; // [{ id, name, author, speed, bpm, objects, date, plays }]

try {
  const raw = fs.readFileSync(LEVELS_FILE, 'utf8');
  const d = JSON.parse(raw);
  if (Array.isArray(d)) pubLevels = d;
  else if (d && Array.isArray(d.levels)) pubLevels = d.levels;
} catch (e) { /* pas encore de niveaux publiés */ }

let saveLvlTimer = null;
function savePubLevels() {
  if (saveLvlTimer) return;
  saveLvlTimer = setTimeout(() => {
    saveLvlTimer = null;
    fs.writeFile(LEVELS_FILE, JSON.stringify(pubLevels), (err) => {
      if (err) console.error('levels.json — écriture impossible :', err.message);
    });
  }, 500);
}

// Valide un niveau reçu (mêmes règles que l'import côté client). Renvoie les objets nettoyés ou null.
function validateLevel(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.speed !== 'number' || !isFinite(o.speed) || o.speed < 360 || o.speed > 820) return null;
  if (o.bpm !== 140 && o.bpm !== 160) return null;
  if (!Array.isArray(o.objects) || o.objects.length < 1 || o.objects.length > 2000) return null;
  let nbCoins = 0, nbGates = 0;
  const clean = [];
  for (let i = 0; i < o.objects.length; i++) {
    const ob = o.objects[i];
    if (!ob || typeof ob !== 'object' || !OBJ_T[ob.t]) return null;
    if (typeof ob.x !== 'number' || !isFinite(ob.x) || ob.x < 0 || ob.x > 200000) return null;
    if (typeof ob.y !== 'number' || !isFinite(ob.y) || ob.y < 0 || ob.y > 540) return null;
    const c = { t: ob.t, x: ob.x, y: ob.y };
    if (ob.t === 'block') {
      if (typeof ob.w !== 'number' || typeof ob.h !== 'number' ||
          ob.w < 20 || ob.h < 20 || ob.w > 2400 || ob.h > 2400) return null;
      c.w = ob.w; c.h = ob.h;
    }
    if (ob.t === 'coin' && ++nbCoins > 3) return null;
    if (ob.t === 'gate' && ++nbGates > 1) return null;
    clean.push(c);
  }
  return clean;
}

function cleanLevelName(raw) {
  let out = "";
  const str = String(raw || "");
  for (let i = 0; i < str.length; i++) { if (str.charCodeAt(i) >= 32) out += str[i]; }
  return out.trim().toUpperCase().slice(0, 24) || "NIVEAU";
}

const today = () => new Date().toISOString().slice(0, 10);

/* ================= WebSocket (RFC 6455, implémentation minimale) ================= */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 262144; // 256 Ko — assez pour publier un niveau complet (jusqu'à 2000 objets)
const COLORS = 8; // le client possède la palette ; le serveur distribue les indices

let nextId = 1;
let nextColor = 0;
const clients = new Map(); // id -> client

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

// Encode un frame texte serveur→client (non masqué).
function wsFrame(str) {
  const data = Buffer.from(str, 'utf8');
  let head;
  if (data.length < 126) {
    head = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126;
    head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, data]);
}

function wsSend(c, obj) {
  if (c.socket.destroyed) return;
  try { c.socket.write(wsFrame(JSON.stringify(obj))); } catch (e) { /* socket fermé */ }
}

function broadcast(obj, exceptId) {
  const frame = wsFrame(JSON.stringify(obj));
  for (const [id, c] of clients) {
    if (id === exceptId || c.socket.destroyed) continue;
    try { c.socket.write(frame); } catch (e) { /* socket fermé */ }
  }
}

function sanitizeName(raw) {
  let n = String(raw || '').toUpperCase().replace(/[^A-Z0-9 _\-]/g, '').trim().slice(0, 14);
  if (!n) n = 'JOUEUR-' + Math.floor(1000 + Math.random() * 9000);
  return n;
}

function publicPlayer(c) {
  return { id: c.id, name: c.name, color: c.color, lvl: c.lvl, lvlName: c.lvlName };
}

function dropClient(c, notify) {
  if (!clients.has(c.id)) return;
  clients.delete(c.id);
  if (notify) {
    broadcast({ t: 'quit', id: c.id });
    broadcast({ t: 'count', n: clients.size });
  }
  try { c.socket.destroy(); } catch (e) { /* déjà fermé */ }
}

function handleMessage(c, msg) {
  let m;
  try { m = JSON.parse(msg); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;

  switch (m.t) {
    case 'hello': {
      c.name = sanitizeName(m.name);
      c.ready = true;
      wsSend(c, {
        t: 'welcome',
        id: c.id,
        color: c.color,
        players: [...clients.values()].filter((o) => o.ready && o.id !== c.id).map(publicPlayer),
        scores: scores,
        n: clients.size
      });
      broadcast({ t: 'join', p: publicPlayer(c) }, c.id);
      broadcast({ t: 'count', n: clients.size });
      break;
    }
    case 'name': {
      if (!c.ready) return;
      c.name = sanitizeName(m.name);
      broadcast({ t: 'join', p: publicPlayer(c) }, c.id); // join = upsert côté client
      break;
    }
    case 'state': {
      if (!c.ready) return;
      // Anti-flood : au plus ~30 états/s par joueur.
      const now = Date.now();
      if (now - c.lastState < 25) return;
      c.lastState = now;
      c.lvl = typeof m.lvl === 'string' ? m.lvl.slice(0, 48) : null;
      c.lvlName = typeof m.lvlName === 'string' ? m.lvlName.slice(0, 26) : '';
      broadcast({
        t: 'state', id: c.id,
        lvl: c.lvl,
        x: +m.x || 0, y: +m.y || 0,
        m: m.m === 'ship' ? 'ship' : 'cube',
        g: m.g === -1 ? -1 : 1,
        r: +m.r || 0,
        d: !!m.d,
        pr: Math.max(0, Math.min(100, +m.pr || 0))
      }, c.id);
      break;
    }
    case 'leave': {
      if (!c.ready) return;
      c.lvl = null; c.lvlName = '';
      broadcast({ t: 'state', id: c.id, lvl: null, d: true }, c.id);
      broadcast({ t: 'join', p: publicPlayer(c) }, c.id);
      break;
    }
    case 'pubLevel': {
      if (!c.ready) return;
      const now = Date.now();
      if (now - c.lastPub < 3000) { wsSend(c, { t: 'published', ok: false, err: 'Trop rapide — attends quelques secondes.' }); return; }
      c.lastPub = now;
      const objs = validateLevel(m);
      if (!objs) { wsSend(c, { t: 'published', ok: false, err: 'Niveau invalide (données rejetées).' }); return; }
      const nm = cleanLevelName(m.name);
      const author = c.name || 'ANON';
      const existing = pubLevels.find((l) => l.author === author && l.name === nm);
      if (existing) {
        existing.objects = objs; existing.speed = m.speed; existing.bpm = m.bpm; existing.date = today();
      } else {
        if (pubLevels.length >= MAX_LEVELS) { wsSend(c, { t: 'published', ok: false, err: 'Catalogue plein.' }); return; }
        pubLevels.push({ id: crypto.randomBytes(6).toString('hex'), name: nm, author: author, speed: m.speed, bpm: m.bpm, objects: objs, date: today(), plays: 0 });
      }
      savePubLevels();
      wsSend(c, { t: 'published', ok: true, name: nm, updated: !!existing });
      break;
    }
    case 'listLevels': {
      if (!c.ready) return;
      const list = pubLevels.map((l) => ({ id: l.id, name: l.name, author: l.author, count: l.objects.length, speed: l.speed, bpm: l.bpm, date: l.date, plays: l.plays || 0 }));
      list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.plays - a.plays));
      wsSend(c, { t: 'levelList', levels: list });
      break;
    }
    case 'getLevel': {
      if (!c.ready) return;
      const lv = pubLevels.find((l) => l.id === m.id);
      if (!lv) { wsSend(c, { t: 'levelData', err: 'Niveau introuvable.' }); return; }
      lv.plays = (lv.plays || 0) + 1;
      savePubLevels();
      wsSend(c, { t: 'levelData', level: { id: lv.id, name: lv.name, author: lv.author, speed: lv.speed, bpm: lv.bpm, objects: lv.objects } });
      break;
    }
    case 'score': {
      if (!c.ready) return;
      const lvlKey = typeof m.lvl === 'string' ? m.lvl.slice(0, 48) : null;
      const lvlName = (typeof m.lvlName === 'string' ? m.lvlName : 'NIVEAU').slice(0, 26);
      if (!lvlKey) return;
      const entry = {
        name: c.name,
        pct: Math.max(0, Math.min(100, Math.floor(+m.pct || 0))),
        time: (+m.pct >= 100 && isFinite(+m.time) && +m.time > 0) ? Math.round(+m.time * 10) / 10 : null,
        coins: Math.max(0, Math.min(3, Math.floor(+m.coins || 0))),
        date: new Date().toISOString().slice(0, 10)
      };
      if (submitScore(lvlKey, lvlName, entry)) {
        broadcast({ t: 'scores', lvl: lvlKey, board: scores[lvlKey] });
      }
      break;
    }
  }
}

// Décode les frames client→serveur (masqués). Gère texte, ping, pong, close.
function onSocketData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  for (;;) {
    if (c.buf.length < 2) return;
    const fin = (c.buf[0] & 0x80) !== 0;
    const op = c.buf[0] & 0x0f;
    const masked = (c.buf[1] & 0x80) !== 0;
    let len = c.buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (c.buf.length < 4) return;
      len = c.buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (c.buf.length < 10) return;
      const big = c.buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_PAYLOAD)) { dropClient(c, true); return; }
      len = Number(big);
      off = 10;
    }
    if (len > MAX_PAYLOAD || !masked) { dropClient(c, true); return; }
    if (c.buf.length < off + 4 + len) return;
    const mask = c.buf.slice(off, off + 4);
    const payload = c.buf.slice(off + 4, off + 4 + len);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    c.buf = c.buf.slice(off + 4 + len);

    if (op === 0x8) { dropClient(c, true); return; }            // close
    if (op === 0x9) {                                           // ping → pong
      const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
      try { c.socket.write(pong); } catch (e) { /* fermé */ }
      continue;
    }
    if (op === 0xa) continue;                                   // pong
    if (op === 0x1 || op === 0x0) {                             // texte (+ continuation)
      c.frag += payload.toString('utf8');
      if (fin) {
        const msg = c.frag;
        c.frag = '';
        handleMessage(c, msg);
      }
      if (c.frag.length > MAX_PAYLOAD) { dropClient(c, true); return; }
    }
  }
}

/* ================= Serveur HTTP ================= */

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    urlPath = '/';
  }
  if (urlPath === '/') urlPath = '/index.html';

  const file = path.normalize(path.join(ROOT, urlPath));
  if (file.indexOf(ROOT) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('403 Interdit');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('404 — fichier introuvable');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const c = {
    id: nextId++,
    socket: socket,
    buf: Buffer.alloc(0),
    frag: '',
    name: '',
    color: (nextColor++) % COLORS,
    lvl: null,
    lvlName: '',
    ready: false,
    lastState: 0,
    lastPub: 0
  };
  clients.set(c.id, c);

  socket.on('data', (chunk) => onSocketData(c, chunk));
  socket.on('close', () => dropClient(c, true));
  socket.on('error', () => dropClient(c, true));
});

// Ping périodique pour purger les connexions mortes.
setInterval(() => {
  const ping = Buffer.from([0x89, 0]);
  for (const c of clients.values()) {
    if (c.socket.destroyed) { dropClient(c, true); continue; }
    try { c.socket.write(ping); } catch (e) { dropClient(c, true); }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log('NEON DASH — serveur multijoueur démarré sur http://localhost:' + PORT + ' (hôte ' + HOST + ', WebSocket /ws)');
});
