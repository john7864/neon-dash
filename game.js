/* ============================================================
   NEON DASH — moteur + niveaux + éditeur (script classique, zéro dépendance)
   NIVEAU 1 : LIGNE DE BASSE (140 BPM, 540 px/s)
   NIVEAU 2 : SURTENSION (160 BPM, 620 px/s, portails de gravité)
   NIVEAU 5 : SINGULARITÉ (150 BPM, vitesse variable, mode onde, orbes, scies mobiles)
   ÉDITEUR  : niveaux personnalisés pilotés par les données
   ============================================================ */
(function () {
'use strict';

/* ---------------- Constantes ---------------- */
var W = 960, H = 540;
/* Largeur de VUE réelle (≥ W) : sur écrans plus larges que 16:9, la caméra
   montre plus de parcours au lieu de laisser des bandes noires. Le gameplay
   reste calé sur W (position joueur, niveaux). Recalculée dans fit(). */
var VW = W;
var GY = 444;                    // surface du sol
var CY = 96;                     // surface du plafond
var GRAV = 2900;
var JUMP = -890;
var PAD_V = -1050;
var SHIP_GRAV = 1500;
var SHIP_THRUST = 3300;
var SHIP_CLAMP = 420;
var STEP = 1 / 120;
var PLAYER_X = Math.round(W * 0.28);
var ROT_SPEED = 5.1;
var WAVE_INSET = 11;             // onde : hitbox 18×18 centrée (plus fine que le cube)
var ORB_V = -900;                // orbe de saut : impulsion (≈ un saut, déclenchable en l'air)
var ORB_GRAV_V = 240;            // orbe de gravité : impulsion vers le nouveau « bas »
var ORB_BUF = 14;                // tampon d'appui pour les orbes : une tape jusqu'à ~115 ms avant l'orbe compte

var COL = {
  bg: '#050508',
  blue: '#3834FF',
  deep: '#030FC6',
  coral: '#FF624D',
  lime: '#C6D32D',
  white: '#F3F3F3',
  cyan: '#3FD3FF',
  pink: '#FF4DC1',
  amber: '#FFB13D'
};

/* ---------------- Persistance (v2 + custom, migration v1) ---------------- */
var SAVE_KEY = 'neondash.v2';
var store = {
  levels: {
    l1: { best: 0, coins: [false, false, false] },
    l2: { best: 0, coins: [false, false, false] },
    l3: { best: 0, coins: [false, false, false] },
    l4: { best: 0, coins: [false, false, false] },
    l5: { best: 0, coins: [false, false, false] }
  },
  attempts: 0, jumps: 0, deaths: 0, muted: false,
  custom: [],
  demoDeleted: false,
  trophies: {},
  pseudo: ''
};
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(store)); } catch (e) {}
}
(function loadStore() {
  try {
    var raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      var d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        ['l1', 'l2', 'l3', 'l4', 'l5'].forEach(function (k) {
          if (d.levels && d.levels[k]) {
            if (typeof d.levels[k].best === 'number') store.levels[k].best = d.levels[k].best;
            if (Array.isArray(d.levels[k].coins)) {
              for (var i = 0; i < 3; i++) store.levels[k].coins[i] = !!d.levels[k].coins[i];
            }
          }
        });
        if (typeof d.attempts === 'number') store.attempts = d.attempts;
        if (typeof d.jumps === 'number') store.jumps = d.jumps;
        if (typeof d.muted === 'boolean') store.muted = d.muted;
        if (Array.isArray(d.custom)) store.custom = d.custom;
        if (typeof d.demoDeleted === 'boolean') store.demoDeleted = d.demoDeleted;
        if (typeof d.deaths === 'number') store.deaths = d.deaths;
        if (d.trophies && typeof d.trophies === 'object' && !Array.isArray(d.trophies)) store.trophies = d.trophies;
        if (typeof d.pseudo === 'string') store.pseudo = d.pseudo;
      }
      return;
    }
    // Migration depuis neondash.v1
    var old = localStorage.getItem('neondash.v1');
    if (old) {
      var o = JSON.parse(old);
      if (o && typeof o === 'object') {
        if (typeof o.best === 'number') store.levels.l1.best = o.best;
        if (Array.isArray(o.coins)) for (var i = 0; i < 3; i++) store.levels.l1.coins[i] = !!o.coins[i];
        if (typeof o.attempts === 'number') store.attempts = o.attempts;
        if (typeof o.jumps === 'number') store.jumps = o.jumps;
        if (typeof o.muted === 'boolean') store.muted = o.muted;
      }
      save();
      localStorage.removeItem('neondash.v1');
    }
  } catch (e) { /* stockage indisponible */ }
})();
if (!Array.isArray(store.custom)) store.custom = [];   // migration douce
if (!store.trophies || typeof store.trophies !== 'object' || Array.isArray(store.trophies)) store.trophies = {};
if (typeof store.deaths !== 'number') store.deaths = 0;

/* ---------------- Audio (100% WebAudio, paramétré par niveau) ---------------- */
var audio = {
  ctx: null, master: null, musicGain: null, sfxGain: null, bassGain: null,
  bpm: 140, cfg: null, octUp: false,
  step: 0, bar: 0, nextTime: 0, timer: null, lastKick: -99, noiseBuf: null,

  ensure: function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = store.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.8;
    this.musicGain.connect(this.master);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.master);
    this.bassGain = this.ctx.createGain();
    this.bassGain.gain.value = 0.7;
    this.bassGain.connect(this.musicGain);
    var len = Math.floor(this.ctx.sampleRate * 0.5);
    var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  },

  beatDur: function () { return 60 / this.bpm; },

  startMusic: function (bpm, cfg) {
    if (!this.ctx) return;
    this.stopMusic();
    this.bpm = bpm;
    this.cfg = cfg;
    this.step = 0; this.bar = 0;
    this.nextTime = this.ctx.currentTime + 0.06;
    var self = this;
    this.timer = setInterval(function () { self.schedule(); }, 30);
  },

  stopMusic: function () {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },

  schedule: function () {
    if (!this.ctx || this.ctx.state !== 'running') return;
    // Onglet en arrière-plan : le minuteur est ralenti (~1 s) et nextTime prend du retard.
    // On saute les pas manqués au lieu de les jouer tous d'un coup au retour.
    if (this.nextTime < this.ctx.currentTime) this.nextTime = this.ctx.currentTime + 0.02;
    var ahead = this.ctx.currentTime + 0.15;
    while (this.nextTime < ahead) {
      this.playStep(this.step, this.nextTime);
      this.step++;
      if (this.step === 16) { this.step = 0; this.bar++; }
      this.nextTime += this.beatDur() / 4;
    }
  },

  playStep: function (s, t) {
    var cfg = this.cfg;
    if (s % 4 === 0) {
      var o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g); g.connect(this.musicGain);
      o.start(t); o.stop(t + 0.26);
      this.lastKick = t;
      this.bassGain.gain.cancelScheduledValues(t);
      this.bassGain.gain.setValueAtTime(0.15, t);
      this.bassGain.gain.linearRampToValueAtTime(0.7, t + 0.2);
    }
    var hn = this.ctx.createBufferSource(), hg = this.ctx.createGain(), hf = this.ctx.createBiquadFilter();
    hn.buffer = this.noiseBuf;
    hf.type = 'highpass'; hf.frequency.value = 7500;
    hg.gain.setValueAtTime(s % 2 === 1 ? 0.13 : 0.08, t);
    hg.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    hn.connect(hf); hf.connect(hg); hg.connect(this.musicGain);
    hn.start(t); hn.stop(t + 0.05);
    var bn = cfg && cfg.bass ? cfg.bass[s] : 0;
    if (bn) {
      var bo = this.ctx.createOscillator(), bg = this.ctx.createGain(), bf = this.ctx.createBiquadFilter();
      bo.type = 'sawtooth'; bo.frequency.value = bn;
      bf.type = 'lowpass'; bf.frequency.value = 800;
      var bd = this.beatDur() / 4;
      bg.gain.setValueAtTime(0.4, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + bd * 0.92);
      bo.connect(bf); bf.connect(bg); bg.connect(this.bassGain);
      bo.start(t); bo.stop(t + bd);
    }
    var lf = cfg && cfg.lead ? cfg.lead[s] : 0;
    if (lf && this.bar % (cfg.leadEvery || 2) === 0) {
      if (this.octUp) lf *= 2;
      var lo = this.ctx.createOscillator(), lg = this.ctx.createGain();
      lo.type = 'square'; lo.frequency.value = lf;
      lg.gain.setValueAtTime(0.07, t);
      lg.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      lo.connect(lg); lg.connect(this.musicGain);
      lo.start(t); lo.stop(t + 0.2);
    }
    // Couches optionnelles (niveau 5) : arpège filtré + caisse claire
    var af = cfg && cfg.arp ? cfg.arp[s] : 0;
    if (af) {
      var ao = this.ctx.createOscillator(), ag = this.ctx.createGain(), aflt = this.ctx.createBiquadFilter();
      ao.type = 'sawtooth'; ao.frequency.value = af;
      aflt.type = 'lowpass';
      aflt.frequency.value = 900 + 700 * (1 + Math.sin(this.bar * 0.8));
      ag.gain.setValueAtTime(0.05, t);
      ag.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      ao.connect(aflt); aflt.connect(ag); ag.connect(this.musicGain);
      ao.start(t); ao.stop(t + 0.12);
    }
    if (cfg && cfg.snare && cfg.snare[s]) {
      var sn = this.ctx.createBufferSource(), sg = this.ctx.createGain(), sf = this.ctx.createBiquadFilter();
      sn.buffer = this.noiseBuf;
      sf.type = 'bandpass'; sf.frequency.value = 1900; sf.Q.value = 0.8;
      sg.gain.setValueAtTime(0.3, t);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      sn.connect(sf); sf.connect(sg); sg.connect(this.musicGain);
      sn.start(t); sn.stop(t + 0.15);
    }
  },

  beatPulse: function () {
    if (!this.ctx || this.lastKick < 0) return 0;
    var d = (this.ctx.currentTime - this.lastKick) / (this.beatDur() * 0.6);
    return (d >= 0 && d < 1) ? 1 - d : 0;
  },

  blip: function (type, f0, f1, dur, vol, when) {
    if (!this.ctx) return;
    var t = this.ctx.currentTime + (when || 0);
    var o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.sfxGain);
    o.start(t); o.stop(t + dur + 0.02);
  },

  sfxJump: function () { this.blip('square', 300, 500, 0.06, 0.22); },
  sfxDeath: function () {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    var n = this.ctx.createBufferSource(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    n.buffer = this.noiseBuf; f.type = 'lowpass'; f.frequency.value = 3000;
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    n.connect(f); f.connect(g); g.connect(this.sfxGain);
    n.start(t); n.stop(t + 0.3);
    this.blip('sawtooth', 400, 60, 0.3, 0.3);
  },
  sfxCoin: function () { this.blip('sine', 880, 880, 0.07, 0.2); this.blip('sine', 1320, 1320, 0.09, 0.2, 0.08); },
  sfxPortal: function () { this.blip('square', 200, 900, 0.18, 0.18); },
  sfxGrav: function () { this.blip('square', 700, 140, 0.16, 0.18); },
  sfxOrb: function () { this.blip('sine', 520, 1400, 0.12, 0.22); this.blip('square', 1040, 1040, 0.05, 0.08, 0.05); },
  sfxSpeed: function (up) { this.blip('sawtooth', up ? 160 : 900, up ? 1400 : 180, 0.28, 0.14); },
  sfxCheckpoint: function () { this.blip('sine', 600, 900, 0.07, 0.2); },
  sfxWin: function () {
    var notes = [523.25, 659.26, 783.99, 1046.5];
    for (var i = 0; i < notes.length; i++) this.blip('square', notes[i], notes[i], 0.14, 0.18, i * 0.12);
  },
  sfxTrophy: function () {
    var notes = [659.26, 830.61, 987.77, 1318.5];
    for (var i = 0; i < notes.length; i++) this.blip('square', notes[i], notes[i], 0.13, 0.16, i * 0.1);
    this.blip('sine', 2637, 2637, 0.3, 0.1, 0.42);
  }
};

/* ---------------- Données runtime du niveau courant ---------------- */
var blocks = [], spikes = [], saws = [], pads = [], portals = [], coins = [], orbs = [];
var gravZones = [];          // plafond solide (niveaux officiels)
var autoCeilRanges = [];     // plafond automatique (niveaux custom)
var shipZones = [];          // zones sans sol (vaisseau / onde) : sol et plafond en blocs
var hasGateObj = false;

function resetLevelData() {
  blocks = []; spikes = []; saws = []; pads = []; portals = []; coins = []; orbs = [];
  gravZones = []; autoCeilRanges = []; shipZones = []; hasGateObj = false;
}

/* Helpers de construction (niveaux 1/2) */
function addBlock(x, y, w, h) { blocks.push({ x: x, y: y, w: w, h: h, floor: false, ceil: false }); }
function addSpike(x, n) {
  for (var i = 0; i < n; i++) spikes.push({ x: x + i * 40, y: GY, hx: x + i * 40 + 8, hy: GY - 22, ceil: false });
}
function addSpikeOn(x, baseY, n) {
  for (var i = 0; i < n; i++) spikes.push({ x: x + i * 40, y: baseY, hx: x + i * 40 + 8, hy: baseY - 22, ceil: false });
}
function addSpikeCeil(x, n) {
  for (var i = 0; i < n; i++) spikes.push({ x: x + i * 40, y: CY, hx: x + i * 40 + 8, hy: CY, ceil: true });
}
function addPad(x) { pads.push({ x: x, y: GY, hy: GY - 12, ceil: false }); }
function addPadCeil(x) { pads.push({ x: x, y: CY, hy: CY, ceil: true }); }
function addSaw(x, y, r) { saws.push({ x: x, y: y, r: r || 26 }); }
function addPortal(mode, x) { portals.push({ mode: mode, dir: 0, x: x - 17, y: 210, w: 34, h: 234, used: false }); }
function addGravPortal(x, dir) { portals.push({ mode: 'grav', dir: dir, x: x - 17, y: 60, w: 34, h: GY - 60, used: false }); }
function addCoin(x, y) { coins.push({ x: x, y: y, id: coins.length }); }
function shipFloor(x, w, top) { blocks.push({ x: x, y: top, w: w, h: 540 - top, floor: true, ceil: false }); }
function shipCeil(x, w, bottom) { blocks.push({ x: x, y: 0, w: w, h: bottom, floor: false, ceil: true }); }
function setShipZone(x0, x1) { shipZones.push({ x0: x0, x1: x1 }); }
function addGravZone(x0, x1) { gravZones.push({ x0: x0, x1: x1 }); }
/* Niveau 5 : portails libres, vitesse, orbes, scies mobiles */
function addPortalAt(mode, x, y, h) { portals.push({ mode: mode, dir: 0, x: x - 17, y: y, w: 34, h: h, used: false }); }
function addSpeedPortal(x, factor, y) {
  // hitbox pleine hauteur (impossible à rater) ; vy = position du dessin
  portals.push({ mode: 'speed', dir: 0, factor: factor, x: x - 17, y: 0, w: 34, h: 540, vy: y == null ? 210 : y, used: false });
}
function addOrb(x, y, kind) { orbs.push({ x: x, y: y, kind: kind || 'jump', used: false, fx: 0 }); }
function addMovingSaw(x, y, r, amp, per, ph) { saws.push({ x: x, y: y, by: y, r: r || 26, amp: amp, per: per, ph: ph || 0 }); }

/* ---------------- Musiques ---------------- */
var MUSIC_L1 = {
  bass: [55, 55, 0, 55, 65.41, 0, 55, 0, 73.42, 0, 55, 0, 49, 0, 82.41, 0],
  lead: { 0: 440, 3: 523.25, 6: 659.26, 10: 880, 14: 523.25 },
  leadEvery: 2, octMid: false
};
var MUSIC_L2 = {
  bass: [55, 55, 0, 55, 65.41, 0, 55, 55, 73.42, 0, 73.42, 55, 49, 0, 82.41, 61.74],
  lead: { 0: 440, 2: 523.25, 4: 659.26, 6: 880, 8: 659.26, 10: 523.25, 12: 440, 14: 659.26 },
  leadEvery: 1, octMid: true
};
var MUSIC_L3 = {
  bass: [55, 0, 55, 55, 82.41, 0, 55, 0, 61.74, 0, 61.74, 0, 49, 49, 92.5, 0],
  lead: { 0: 880, 2: 659.26, 4: 523.25, 5: 659.26, 8: 880, 10: 1046.5, 12: 987.77, 14: 659.26 },
  leadEvery: 1, octMid: true
};

var MUSIC_L5 = {
  bass: [46.25, 0, 46.25, 46.25, 0, 46.25, 55, 0, 61.74, 0, 61.74, 69.3, 0, 55, 82.41, 0],
  lead: { 0: 739.99, 3: 880, 6: 1108.73, 8: 987.77, 10: 880, 12: 739.99, 14: 659.26 },
  arp: [369.99, 440, 554.37, 739.99, 369.99, 440, 554.37, 739.99, 329.63, 440, 554.37, 659.26, 329.63, 440, 554.37, 659.26],
  snare: { 4: 1, 12: 1 },
  leadEvery: 2, octMid: true
};

/* ---------------- Types d'objets (format de données + éditeur) ---------------- */
var OBJ_TYPES = {
  spike: 'Pic', spikeCeil: 'Pic plafond', block: 'Bloc',
  pad: 'Pad', padCeil: 'Pad plafond', saw: 'Scie',
  portalCube: 'Portail cube', portalShip: 'Portail vaisseau',
  portalGravDown: 'Gravité ↓', portalGravUp: 'Gravité ↑',
  orb: 'Orbe de saut', orbGrav: 'Orbe de gravité', portalWave: 'Portail onde',
  speedSlow: 'Vitesse ×0.8', speedNormal: 'Vitesse ×1', speedFast: 'Vitesse ×1.3',
  coin: 'Pièce', gate: 'Porte d\'arrivée'
};

var SPEED_F = { speedSlow: 0.8, speedNormal: 1, speedFast: 1.3 };

/* Charge un niveau depuis un tableau d'objets (trié par x, sans code) */
function loadObjects(arr) {
  var sorted = arr.slice().sort(function (a, b) { return a.x - b.x; });
  var gateX = null, maxX = 0;
  sorted.forEach(function (o) {
    maxX = Math.max(maxX, o.x + (o.w || 40));
    switch (o.t) {
      case 'spike': spikes.push({ x: o.x, y: GY, hx: o.x + 8, hy: GY - 22, ceil: false }); break;
      case 'spikeCeil': spikes.push({ x: o.x, y: CY, hx: o.x + 8, hy: CY, ceil: true }); break;
      case 'block': blocks.push({ x: o.x, y: o.y, w: o.w, h: o.h, floor: false, ceil: false }); break;
      case 'pad': pads.push({ x: o.x, y: GY, hy: GY - 12, ceil: false }); break;
      case 'padCeil': pads.push({ x: o.x, y: CY, hy: CY, ceil: true }); break;
      case 'saw': saws.push({ x: o.x, y: o.y, r: 26 }); break;
      case 'portalCube': portals.push({ mode: 'cube', dir: 0, x: o.x, y: 210, w: 34, h: 234, used: false }); break;
      case 'portalShip': portals.push({ mode: 'ship', dir: 0, x: o.x, y: 210, w: 34, h: 234, used: false }); break;
      case 'portalGravUp': portals.push({ mode: 'grav', dir: -1, x: o.x, y: 60, w: 34, h: GY - 60, used: false }); break;
      case 'portalGravDown': portals.push({ mode: 'grav', dir: 1, x: o.x, y: 60, w: 34, h: GY - 60, used: false }); break;
      case 'coin': coins.push({ x: o.x, y: o.y, id: coins.length }); break;
      case 'portalWave': portals.push({ mode: 'wave', dir: 0, x: o.x, y: 210, w: 34, h: 234, used: false }); break;
      case 'orb': orbs.push({ x: o.x, y: o.y, kind: 'jump', used: false, fx: 0 }); break;
      case 'orbGrav': orbs.push({ x: o.x, y: o.y, kind: 'grav', used: false, fx: 0 }); break;
      case 'speedSlow': case 'speedNormal': case 'speedFast':
        portals.push({ mode: 'speed', dir: 0, factor: SPEED_F[o.t], x: o.x, y: 0, w: 34, h: 540, vy: 210, used: false }); break;
      case 'gate': gateX = o.x; hasGateObj = true; break;
    }
  });
  cur.gateX = gateX != null ? gateX : maxX;
  cur.length = gateX != null ? gateX + 500 : maxX + 1500;

  // Plafond automatique : sections vaisseau + sections gravité inversée
  var ship = false, gs = 1, start = 0;
  sorted.forEach(function (o) {
    if ((o.t === 'portalShip' || o.t === 'portalWave') && !ship) { ship = true; start = o.x; }
    else if (o.t === 'portalCube' && ship) { ship = false; autoCeilRanges.push({ x0: start, x1: o.x + 500 }); }
    else if (o.t === 'portalGravUp' && gs === 1) { gs = -1; start = o.x; }
    else if (o.t === 'portalGravDown' && gs === -1) { gs = 1; autoCeilRanges.push({ x0: start, x1: o.x + 500 }); }
  });
  if (ship) autoCeilRanges.push({ x0: start, x1: cur.length });
  if (gs === -1) autoCeilRanges.push({ x0: start, x1: cur.length });
}

/* ---------------- Définition des niveaux ---------------- */
var LEVELS = [
  {
    id: 'l1', name: 'NIVEAU 1', sub: 'LIGNE DE BASSE', diff: 'NORMAL',
    bpm: 140, speed: 540, length: 26200, gateX: 26000, music: MUSIC_L1,
    build: function () {
      addSpike(1600, 1);
      addSpike(2040, 1);
      addSpike(2480, 2);
      addBlock(2920, GY - 40, 40, 40);
      addSpike(3360, 1);
      addBlock(3800, GY - 40, 160, 40);
      addBlock(4000, GY - 80, 160, 80);
      addSpike(4440, 2); addCoin(4460, GY - 130);
      addSpike(4920, 1);

      addSpike(5300, 2);
      addSpike(5740, 3);
      addPad(6140); addSpike(6240, 3);
      addBlock(6940, GY - 120, 160, 20);
      addBlock(7280, GY - 160, 160, 20);
      addSpike(7760, 2);
      addSpike(8120, 1);

      setShipZone(8200, 13600);
      addPortal('ship', 8240);
      shipFloor(8200, 2400, GY);
      shipCeil(8200, 2400, 200);
      addBlock(9400, 364, 80, 176);
      addBlock(10100, 0, 80, 280);
      shipFloor(10600, 1400, GY - 40);
      shipCeil(10600, 1400, 244);
      addCoin(11250, 272);
      shipFloor(12000, 1600, GY);
      shipCeil(12000, 1600, 200);
      addBlock(12400, 364, 80, 176);
      addBlock(12800, 0, 80, 280);
      addPortal('cube', 13320);

      addSpike(13900, 3);
      addBlock(14500, GY - 40, 360, 40);
      addSpikeOn(14780, GY - 40, 1);
      addBlock(14940, GY - 80, 160, 80);
      addSpike(15460, 2);
      addBlock(15760, GY - 120, 280, 20);
      addSaw(15940, GY - 150, 26);
      addBlock(16300, GY - 80, 160, 80);
      addBlock(16480, GY - 160, 240, 20);
      addCoin(16580, GY - 26);
      addSpike(17220, 3);
      addSpike(17720, 2);

      addPad(18200); addSpike(18320, 3);
      addSaw(18960, GY - 26, 26);
      addSaw(19360, GY - 26, 26);
      addPad(19860); addSpike(19960, 3);
      addPad(20600); addSpike(20720, 2);
      addPad(21140); addSpike(21260, 2);
      addSpike(21760, 2);

      addSpike(22100, 2);
      addSpike(22500, 3);
      addSpike(22900, 2);
      addSpike(23300, 3);
      addBlock(23800, GY - 40, 120, 40);
      addSpike(24160, 2);
      addSpike(24600, 2);
      addSpike(25000, 3);
      addSpike(25400, 3);
      hasGateObj = true;
    }
  },
  {
    id: 'l2', name: 'NIVEAU 2', sub: 'SURTENSION', diff: 'DIFFICILE',
    bpm: 160, speed: 620, length: 29500, gateX: 28800, music: MUSIC_L2,
    build: function () {
      addSpike(1800, 1);
      addSpike(2250, 1);
      addSpike(2700, 2);
      addSpike(3150, 1);
      addSpike(3600, 2);
      addBlock(4100, GY - 40, 120, 40);
      addBlock(4260, GY - 80, 120, 80);
      addSpike(4700, 2);
      addPad(5080); addSpike(5200, 3);
      addCoin(5260, GY - 170);
      addSpike(5750, 2);

      addGravZone(6000, 11000);
      addGravPortal(6400, -1);
      addSpikeCeil(6800, 2);
      addSpikeCeil(7240, 2);
      addSpikeCeil(7680, 3);
      addBlock(8100, CY, 120, 40);
      addSpikeCeil(8680, 2);
      addPadCeil(9000); addSpikeCeil(9140, 3);
      addSpikeCeil(9650, 2);
      addSpikeCeil(10100, 2);
      addGravPortal(10550, 1);

      setShipZone(11100, 16500);
      addPortal('ship', 11100);
      shipFloor(11100, 700, GY);
      shipCeil(11100, 700, 264);
      shipFloor(11800, 800, GY - 20);
      shipCeil(11800, 800, 244);
      addBlock(12100, 384, 80, 156);
      shipFloor(12600, 800, GY);
      shipCeil(12600, 800, 244);
      addGravPortal(13000, -1);
      shipFloor(13400, 800, GY - 20);
      shipCeil(13400, 800, 244);
      addBlock(13700, 0, 80, 284);
      addBlock(14100, 384, 80, 156);
      shipFloor(14200, 800, GY);
      shipCeil(14200, 800, 264);
      addGravPortal(14600, 1);
      shipFloor(15000, 800, GY);
      shipCeil(15000, 800, 264);
      addCoin(15250, 410);
      addBlock(15450, 404, 80, 136);
      shipFloor(15800, 700, GY);
      shipCeil(15800, 700, 244);
      addPortal('cube', 16400);

      addSpike(16800, 3);
      addSpike(17250, 2);
      addSpike(17650, 3);
      addSpike(18050, 2);
      addBlock(18500, GY - 120, 240, 20);
      addSaw(18620, GY - 150, 26);
      addPad(19200); addSpike(19340, 3);
      addPad(19650); addSpike(19790, 3);
      addPad(20100); addSpike(20240, 3);
      addSpike(20900, 2);
      addSpike(21300, 3);
      addSpike(21750, 2);
      addSpike(22200, 3);

      addGravZone(22500, 27200);
      addGravPortal(22600, -1);
      addSpikeCeil(23000, 2);
      addSpikeCeil(23350, 2);
      addGravPortal(23700, 1);
      addSpike(24150, 2);
      addGravPortal(24500, -1);
      addSpikeCeil(24950, 2);
      addGravPortal(25300, 1);
      addSpike(25740, 2);
      addGravPortal(26100, -1);
      addSpikeCeil(26550, 2);
      addCoin(26560, CY + 120);
      addGravPortal(26900, 1);

      addSpike(27400, 2);
      addSpike(27850, 2);
      hasGateObj = true;
    }
  },
  {
    id: 'l3', name: 'NIVEAU 3', sub: 'RUPTURE', diff: 'EXTRÊME',
    bpm: 180, speed: 700, length: 30400, gateX: 30200, music: MUSIC_L3,
    /* Équité prouvée par solveur (recherche par faisceau sur la physique réelle,
       inputs limités à un changement par 4 frames) : finissable + 3 pièces
       atteignables en une seule course. */
    build: function () {
      // A) Intro nerveuse
      addSpike(1800, 1);
      addSpike(2350, 1);
      addSpike(2900, 2);
      addSpike(3500, 1);
      addBlock(4050, GY - 40, 120, 40);
      addSpike(4600, 2);
      addSpike(5150, 3);
      addBlock(5750, GY - 40, 120, 40);
      addSpikeOn(5790, GY - 40, 1);

      // B) Couloir de scies
      addSaw(6600, GY - 26, 26);
      addSaw(7150, GY - 26, 26);
      addSpike(7650, 2);
      addSaw(8150, GY - 26, 26);
      addBlock(8650, GY - 120, 280, 20);
      addSaw(8790, GY - 150, 26);
      addSaw(9350, GY - 30, 26);
      addSpike(9900, 3);
      addCoin(9950, GY - 180);
      addSaw(10450, GY - 26, 26);

      // C) Vaisseau avec flips de gravité
      setShipZone(11000, 15800);
      addPortal('ship', 11040);
      shipFloor(11000, 1200, GY);
      shipCeil(11000, 1200, 220);
      shipFloor(12200, 1000, GY - 30);
      shipCeil(12200, 1000, 250);
      addGravPortal(12800, -1);
      shipFloor(13200, 1000, GY);
      shipCeil(13200, 1000, 240);
      addBlock(13500, 0, 80, 260);
      addGravPortal(14200, 1);
      shipFloor(14200, 800, GY - 20);
      shipCeil(14200, 800, 240);
      addCoin(14650, 330);
      shipFloor(15000, 800, GY);
      shipCeil(15000, 800, 220);
      addPortal('cube', 15700);

      // D) Gravité rapide (course au plafond)
      addGravZone(16300, 21200);
      addGravPortal(16600, -1);
      addSpikeCeil(17050, 2);
      addSpikeCeil(17600, 3);
      addGravPortal(18100, 1);
      addSpike(18550, 2);
      addGravPortal(19000, -1);
      addSpikeCeil(19450, 2);
      addCoin(19500, CY + 150);
      addGravPortal(19950, 1);
      addSpike(20400, 3);

      // E) Enchaînement de pads + scies
      addPad(21800); addSpike(21940, 3);
      addPad(22500); addSpike(22640, 3);
      addSaw(23300, GY - 30, 26);
      addPad(23800); addSpike(23940, 3);
      addSaw(24600, GY - 26, 26);
      addSpike(25100, 2);

      // F) Finale rythmique
      addSpike(25700, 2);
      addSpike(26150, 3);
      addBlock(26700, GY - 40, 120, 40);
      addSpike(27250, 3);
      addSpike(27800, 2);
      addSpike(28350, 3);
      addSpike(28900, 2);
      addSpike(29400, 3);
      hasGateObj = true;
    }
  },
  {
    id: 'l4', name: 'NIVEAU 4', sub: 'ASCENSION', diff: 'NINJA',
    bpm: 170, speed: 560, length: 9800, gateX: 9600, music: MUSIC_L3,
    // Parcours parkour : escalade de tours de blocs puis redescente, sauts au bon
    // moment. Équité prouvée par le solveur (passage le plus dur : 19 trajectoires,
    // aucun saut à la frame près). Marches ≤ 84 px (apex ~136 px), blocs larges (180).
    build: function () {
      // Échauffement au sol
      addSpike(1400, 1);
      addSpike(1900, 2);
      addSpike(2300, 1);
      // TOUR 1 — montée modérée (4 marches) puis descente
      addBlock(2650, 360, 180, 84);
      addBlock(2960, 294, 180, 150);
      addBlock(3270, 228, 180, 216);
      addBlock(3580, 162, 180, 282);
      addCoin(3620, 130);
      addBlock(3890, 162, 180, 282);
      addBlock(4200, 228, 180, 216);
      addBlock(4510, 294, 180, 150);
      // Sol : deux sauts à chronométrer par-dessus les pics
      addSpike(4950, 2);
      addSpike(5410, 2);
      // TOUR 2 — le grand mur ninja (5 marches, sommet au ras du plafond)
      addBlock(5840, 360, 180, 84);
      addBlock(6150, 294, 180, 150);
      addBlock(6460, 228, 180, 216);
      addBlock(6770, 162, 180, 282);
      addBlock(7080, 96, 180, 348);
      addCoin(7120, 66);
      addBlock(7390, 96, 180, 348);
      addBlock(7700, 162, 180, 282);
      addBlock(8010, 228, 180, 216);
      addCoin(8050, 200);
      addBlock(8320, 294, 180, 150);
      // Finale au sol
      addSpike(8800, 2);
      addSpike(9220, 3);
      hasGateObj = true;
    }
  },
  {
    id: 'l5', name: 'NIVEAU 5', sub: 'SINGULARITÉ', diff: 'DÉMON',
    bpm: 150, speed: 600, length: 30800, gateX: 30600, music: MUSIC_L5, theme: 'warp',
    banners: [
      { x: 5600, text: 'HYPERVITESSE ×1.25' },
      { x: 11480, text: 'MODE ONDE' },
      { x: 14080, text: 'GRAVITÉ INVERSÉE' },
      { x: 15580, text: 'SURCHAUFFE' },
      { x: 21400, text: 'SINGULARITÉ ×1.35' }
    ],
    build: function () {
      var k;
      // A) ÉVEIL (600 px/s) — orbes de saut
      addSpike(1400, 1);
      addSpike(1900, 2);
      addSpike(2500, 9);                   // fosse trop longue pour un saut : orbe obligatoire
      addOrb(2700, 300);
      addBlock(3300, GY - 40, 160, 40);    // escalier
      addBlock(3460, GY - 80, 160, 80);
      addSpike(3720, 2);
      addOrb(4000, 330);                   // route haute (facultative) vers la plateforme
      addBlock(4100, 236, 360, 20);
      addCoin(4600, 110);
      addSpike(4500, 3);
      addSpike(5000, 2);
      addSpike(5350, 1);

      // B) HYPERVITESSE (×1.25) — orbes de gravité
      addSpeedPortal(5600, 1.25);
      addSpike(6100, 2);
      addBlock(6600, GY - 40, 160, 40);
      addSpikeOn(6680, GY - 40, 1);
      addPad(7200); addSpike(7300, 4);
      addGravZone(7800, 10900);
      addOrb(8050, 330, 'grav');
      addSpike(8150, 12);                  // sol piégé : passage au plafond forcé
      addSpikeCeil(8800, 2);
      addSpikeCeil(9200, 2);               // atterrissage tôt : le temps de viser l'orbe
      addOrb(9900, 230, 'grav');
      addSpikeCeil(9950, 10);              // plafond piégé : retour au sol forcé
      addSpike(10500, 2);
      addSpeedPortal(10950, 1);

      // C) MODE ONDE (600 px/s) — maintenu = monte à 45°, relâché = descend
      setShipZone(11200, 21000);
      addPortalAt('wave', 11500, 150, 294);
      shipFloor(11200, 1800, GY);
      shipCeil(11200, 1600, 200);
      // C1 zigzag : piliers alternés tous les 220 px (large marge à chaque virage)
      for (k = 0; k < 2; k++) {
        addBlock(11900 + k * 440, 300, 40, 144);
        addBlock(12120 + k * 440, 200, 40, 140);
      }
      // C2 escalier montant / encoche à pièce / escalier descendant (couloir 160 px)
      shipCeil(12800, 200, 284);
      for (k = 0; k < 5; k++) {
        shipFloor(13000 + k * 40, 40, 404 - k * 40);
        shipCeil(13000 + k * 40, 40, 244 - k * 40);
      }
      shipFloor(13200, 280, 244);
      shipCeil(13200, 80, 84);
      shipCeil(13280, 140, 16);            // encoche : la pièce 2 s'y cache
      addCoin(13350, 50);
      shipCeil(13420, 60, 84);
      for (k = 0; k < 4; k++) {
        shipFloor(13480 + k * 40, 40, 284 + k * 40);
        shipCeil(13480 + k * 40, 40, 124 + k * 40);
      }
      shipFloor(13640, 1960, GY);
      shipCeil(13640, 360, 284);
      // C3 onde à gravité inversée (maintenir = descendre)
      shipCeil(14000, 1400, 200);
      addGravPortal(14100, -1);
      addBlock(14400, 300, 40, 144);
      addBlock(14650, 200, 40, 140);
      addBlock(14900, 300, 40, 144);
      addGravPortal(15200, 1);

      // D) SURCHAUFFE — vaisseau + scies mobiles (couloir 180–444)
      shipCeil(15400, 5600, 180);
      addPortalAt('ship', 15600, 180, 264);
      shipFloor(15600, 5400, GY);
      // Phases calées sur le passage du joueur (addTimedSaw) : configuration voulue à l'arrivée
      addTimedSaw(16200, 312, 80, 1.2, 0);           // ciseaux fermés au centre : passe dehors
      addTimedSaw(16200, 312, 80, 1.2, Math.PI);
      addTimedSaw(16700, 312, 100, 1.3, Math.PI / 2);   // slalom : bas…
      addTimedSaw(17150, 312, 100, 1.3, -Math.PI / 2);  // …haut…
      addTimedSaw(17600, 312, 100, 1.3, Math.PI / 2);   // …bas…
      addTimedSaw(18050, 312, 100, 1.3, -Math.PI / 2);  // …haut
      addBlock(18500, 330, 80, 114);                    // fente entre deux piliers
      addBlock(18900, 180, 80, 110);
      addTimedSaw(19400, 312, 80, 1.2, Math.PI / 2);    // ciseaux ouverts au passage
      addTimedSaw(19400, 312, 80, 1.2, -Math.PI / 2);
      addCoin(19400, 312);                 // pièce 3 : au cœur des ciseaux
      addTimedSaw(19900, 312, 110, 1.4, 0);
      addTimedSaw(20300, 312, 110, 1.4, Math.PI);
      addPortalAt('cube', 20600, 180, 264);

      // E) SINGULARITÉ (×1.35)
      addSpeedPortal(21400, 1.35);
      addSpike(22000, 2);
      addSpike(22700, 21);                 // longue fosse : chaîne de deux orbes
      addOrb(22950, 300);
      addOrb(23300, 210);
      addTimedSaw(24500, 380, 50, 0.8, 0);           // scie sauteuse : saut au sommet
      addPad(25000); addSpike(25120, 4);
      addGravZone(25800, 28200);
      addOrb(26000, 330, 'grav');
      addSpike(26100, 11);
      addSpikeCeil(26800, 2);
      addGravPortal(27400, 1);
      addSpike(28400, 3);
      addSpike(28950, 2);
      addSpike(29500, 3);
      addSpike(30050, 2);
      hasGateObj = true;
    }
  }
];

var cur = LEVELS[0];
var curSaveRef = store.levels.l1;
var selectedLevel = 0;

function customLevelDescriptor(rec) {
  return {
    id: rec.id, name: rec.name,
    sub: rec.id === 'demo' ? 'MODÈLE DE DÉPART' : 'NIVEAU PERSONNALISÉ',
    diff: rec.id === 'demo' ? 'DÉMO' : 'CUSTOM',
    bpm: rec.bpm, speed: rec.speed, music: rec.bpm === 160 ? MUSIC_L2 : MUSIC_L1,
    custom: true, objects: rec.objects
  };
}
function levelList() {
  return LEVELS.concat(store.custom.map(customLevelDescriptor));
}
function findCustom(id) {
  for (var i = 0; i < store.custom.length; i++) if (store.custom[i].id === id) return store.custom[i];
  return null;
}

/* ---------------- NIVEAU DÉMO (données pures, format d'export) ---------------- */
/* Vitrine de l'éditeur — difficulté facile, ~13 000 px (~24 s à 540 px/s).
   Équité vérifiée par le calcul : saut 136 px / 331 px, pad ~391 px,
   atterrissages ≥ 160 px, couloirs vaisseau 200 px, passages piliers 160 px. */
var DEMO_LEVEL = {
  id: 'demo', name: 'NIVEAU DÉMO', speed: 540, bpm: 140,
  objects: [
    // 1) 1600–3800 : échauffement ; pièce 1 au-dessus du double pic
    { t: 'spike', x: 1600, y: 444 },
    { t: 'spike', x: 2000, y: 444 },
    { t: 'spike', x: 2400, y: 444 },
    { t: 'spike', x: 2840, y: 444 },
    { t: 'spike', x: 2880, y: 444 },
    { t: 'coin', x: 2880, y: 314 },
    { t: 'spike', x: 3300, y: 444 },
    { t: 'spike', x: 3660, y: 444 },
    // 2) 3800–5800 : 2 pads au-dessus de champs de 3 pics, escalier, scie sur plateforme
    { t: 'pad', x: 3900, y: 444 },
    { t: 'spike', x: 4020, y: 444 },
    { t: 'spike', x: 4060, y: 444 },
    { t: 'spike', x: 4100, y: 444 },
    { t: 'pad', x: 4500, y: 444 },
    { t: 'spike', x: 4620, y: 444 },
    { t: 'spike', x: 4660, y: 444 },
    { t: 'spike', x: 4700, y: 444 },
    { t: 'block', x: 5300, y: 404, w: 40, h: 40 },
    { t: 'block', x: 5400, y: 364, w: 40, h: 80 },
    { t: 'block', x: 5760, y: 324, w: 200, h: 20 },
    { t: 'saw', x: 5860, y: 294 },
    // 3) 6300–8400 : vaisseau, couloir large 200 px, 2 piliers (passages 160 px)
    { t: 'portalShip', x: 6300, y: 210 },
    { t: 'block', x: 6400, y: 0, w: 1800, h: 244 },
    { t: 'block', x: 7000, y: 404, w: 80, h: 40 },
    { t: 'block', x: 7600, y: 0, w: 80, h: 284 },
    { t: 'coin', x: 7300, y: 270 },
    { t: 'portalCube', x: 8400, y: 210 },
    // 4) 9000–10400 : mini section gravité (course au plafond)
    { t: 'portalGravUp', x: 9000, y: 60 },
    { t: 'spikeCeil', x: 9400, y: 96 },
    { t: 'spikeCeil', x: 9900, y: 96 },
    { t: 'portalGravDown', x: 10400, y: 60 },
    // 5) 10800–12700 : finale ; pièce 3 au-dessus du triple (via le pad)
    { t: 'spike', x: 11000, y: 444 },
    { t: 'spike', x: 11040, y: 444 },
    { t: 'pad', x: 11400, y: 444 },
    { t: 'spike', x: 11520, y: 444 },
    { t: 'spike', x: 11560, y: 444 },
    { t: 'spike', x: 11600, y: 444 },
    { t: 'coin', x: 11600, y: 244 },
    { t: 'spike', x: 12200, y: 444 },
    { t: 'spike', x: 12240, y: 444 },
    { t: 'gate', x: 12700, y: 444 }
  ]
};

/* Insère une copie de la démo dans custom[] si absente.
   Jamais ré-insérée si l'utilisateur l'a supprimée (demoDeleted) ;
   si l'utilisateur la modifie, sa version (même id) est conservée telle quelle. */
function seedDemo() {
  if (findCustom('demo')) return;
  var copy = JSON.parse(JSON.stringify(DEMO_LEVEL));
  copy.createdAt = Date.now();
  copy.best = 0;
  copy.coins = [false, false, false];
  store.custom.push(copy);
  save();
}
if (!store.demoDeleted) seedDemo();

function loadLevelData(lvl) {
  cur = lvl;
  resetLevelData();
  if (lvl.objects) {
    loadObjects(lvl.objects);
  } else {
    lvl.build();
  }
  if (lvl.id === 'l1' || lvl.id === 'l2' || lvl.id === 'l3' || lvl.id === 'l4' || lvl.id === 'l5') curSaveRef = store.levels[lvl.id];
  else {
    var rec = findCustom(lvl.id);
    curSaveRef = rec || { best: 0, coins: [false, false, false] };
  }
}
function loadLevel(idx) {
  loadLevelData(levelList()[idx]);
}

function inShipZone(x) {
  for (var i = 0; i < shipZones.length; i++) {
    if (x >= shipZones[i].x0 && x < shipZones[i].x1) return true;
  }
  return false;
}
/* Vitesse de défilement à une abscisse (dernier portail de vitesse franchi) */
function speedAt(x) {
  var f = 1, bx = -1;
  for (var i = 0; i < portals.length; i++) {
    var po = portals[i];
    if (po.mode === 'speed' && po.x <= x && po.x > bx) { bx = po.x; f = po.factor; }
  }
  return cur.speed * f;
}
/* Temps de niveau auquel le joueur (p.x) atteint x depuis le départ (portails de vitesse inclus).
   La vitesse ne dépend jamais des inputs : la position d'une scie mobile au passage du joueur
   est donc fixe → on règle sa phase pour une configuration voulue à l'arrivée. */
function timeAt(x) {
  var sp = portals.filter(function (po) { return po.mode === 'speed'; }).sort(function (a, b) { return a.x - b.x; });
  var t = 0, px = 0, v = cur.speed;
  for (var i = 0; i < sp.length; i++) {
    var trig = sp[i].x - 40;              // p.x + 40 > po.x : entrée dans le portail
    if (trig >= x) break;
    t += (trig - px) / v; px = trig; v = cur.speed * sp[i].factor;
  }
  return t + (x - px) / v;
}
/* Scie mobile dont l'angle vaut « ang » quand le centre du joueur passe à son aplomb */
function addTimedSaw(x, y, amp, per, ang) {
  addMovingSaw(x, y, 26, amp, per, ang - Math.PI * 2 * timeAt(x - 20) / per);
}
/* Scies mobiles : position calée sur l'horloge du niveau (déterministe à x donné) */
function updateMovingSaws() {
  for (var i = 0; i < saws.length; i++) {
    var s = saws[i];
    if (s.amp) s.y = s.by + s.amp * Math.sin(lvlClock * Math.PI * 2 / s.per + s.ph);
  }
}
function inGravZone(x) {
  for (var i = 0; i < gravZones.length; i++) {
    if (x >= gravZones[i].x0 && x < gravZones[i].x1) return true;
  }
  return false;
}

/* ---------------- Décor procédural (parallaxe) ---------------- */
var mountains = [];
for (var mi = 0; mi < 150; mi++) {
  mountains.push({ x: mi * 260, h: 60 + ((mi * 137) % 140) });
}
var floatSquares = [];
for (var si = 0; si < 110; si++) {
  floatSquares.push({
    x: si * 330 + (si * 97) % 120,
    y: 30 + (si * 53) % 330,
    sz: 14 + (si * 29) % 40,
    rot: si * 0.7,
    lime: si % 4 === 0
  });
}

/* ---------------- État du jeu ---------------- */
var state = 'menu';        // menu | playing | paused | dead | win | editor
var mode = 'cube';
var gravitySign = 1;
var practice = false;
var testing = false;       // test depuis l'éditeur
var p = { x: 0, y: GY - 40, vy: 0, prevX: 0, prevY: 0, dead: false };
var onGround = true, rot = 0, camX = 0;
var attempts = 0, jumpsRun = 0, attemptTime = 0;
var runSpeed = 540, lvlClock = 0;   // vitesse effective (portails de vitesse) + horloge du niveau
var waveTrail = [];                 // traînée en zigzag du mode onde (x, y, x, y…)
var deathT = 0, shakeT = 0, winT = 0, winShown = false;
var cps = [];
var held = false;
var heldSteps = 0, relPending = false;   // un appui dure toujours au moins un pas de physique
var orbBuf = 0;                          // pas restants pendant lesquels une tape récente active une orbe
var trailAcc = 0, sawRot = 0, frameDt = 0, tNow = 0;

/* ---------------- Particules (pool) ---------------- */
var POOL = 420, pool = [];
for (var pi = 0; pi < POOL; pi++) {
  pool.push({ alive: false, shard: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 3, col: COL.white, g: 0, rot: 0, vr: 0 });
}
function spawnP(cfg) {
  for (var i = 0; i < POOL; i++) {
    var q = pool[i];
    if (!q.alive) {
      q.alive = true; q.shard = !!cfg.shard;
      q.x = cfg.x; q.y = cfg.y; q.vx = cfg.vx; q.vy = cfg.vy;
      q.life = cfg.life; q.maxLife = cfg.life;
      q.size = cfg.size; q.col = cfg.col; q.g = cfg.g || 0;
      q.rot = cfg.rot || 0; q.vr = cfg.vr || 0;
      return;
    }
  }
}
function updateParticles(dt) {
  for (var i = 0; i < POOL; i++) {
    var q = pool[i];
    if (!q.alive) continue;
    q.life -= dt;
    if (q.life <= 0) { q.alive = false; continue; }
    q.x += q.vx * dt; q.y += q.vy * dt; q.vy += q.g * dt; q.rot += q.vr * dt;
  }
}
function explode() {
  var cols = [COL.white, COL.blue, COL.coral];
  for (var i = 0; i < 14; i++) {
    var a = Math.random() * Math.PI * 2, sp = 180 + Math.random() * 380;
    spawnP({
      shard: true, x: p.x + 20, y: p.y + 20,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 160,
      life: 0.7 + Math.random() * 0.3, size: 6 + Math.random() * 7,
      col: cols[i % 3], g: 1500 * gravitySign, rot: Math.random() * 6, vr: Math.random() * 14 - 7
    });
  }
}

/* ---------------- DOM ---------------- */
function $(id) { return document.getElementById(id); }
var canvas = $('game');
var ctx = canvas.getContext('2d');
var elMenu = $('menu'), elPause = $('pause'), elWin = $('win'), elFlash = $('flash');
var elEditor = $('editor'), elMyLevels = $('myLevels'), elPublic = $('publicLevels');
var elExportModal = $('exportModal'), elImportModal = $('importModal');
var elTrophies = $('trophies');
var elBtnPause = $('btnPause'), elBtnEdit = $('btnEdit'), elPractice = $('practice');
var elRotate = $('rotate'), elBtnFull = $('btnFull');
function showEl(el) { el.classList.remove('hidden'); }
function hideEl(el) { el.classList.add('hidden'); }

var flashTimer = null;
function flash(text) {
  elFlash.textContent = text;
  elFlash.classList.remove('hidden', 'show');
  void elFlash.offsetWidth;
  elFlash.classList.add('show');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(function () { elFlash.classList.add('hidden'); }, 800);
}

var edMsgTimer = null;
function edMsg(text) {
  var el = $('edMsg');
  el.textContent = text;
  el.classList.remove('hidden');
  if (edMsgTimer) clearTimeout(edMsgTimer);
  edMsgTimer = setTimeout(function () { el.classList.add('hidden'); }, 2600);
}

/* ---------------- Actions de jeu ---------------- */
function doJump() {
  orbBuf = 0;                  // la tape a servi à sauter : elle ne déclenche pas aussi une orbe
  p.vy = JUMP * gravitySign;
  onGround = false;
  jumpsRun++; store.jumps++;
  audio.sfxJump();
}

function snapRot() { rot = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2); }

function curSave() { return curSaveRef; }

/* ---------------- Trophées ---------------- */
/* Icônes SVG inline 26×26 (même style que les outils de l'éditeur) */
function trophIcon(d) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter">' + d + '</svg>';
}
var TROPHIES = [
  { id: 'first-steps', name: 'PREMIERS PAS', cond: 'Terminer le NIVEAU DÉMO',
    icon: trophIcon('<polygon points="12,3 14.7,8.6 21,9.3 16.5,13.6 17.6,20 12,17 6.4,20 7.5,13.6 3,9.3 9.3,8.6"/>') },
  { id: 'baseline', name: 'LIGNE DE BASSE', cond: 'Terminer le niveau 1',
    icon: trophIcon('<path d="M9 18 V5 l10 -2 v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>') },
  { id: 'overdrive', name: 'SURTENSION', cond: 'Terminer le niveau 2',
    icon: trophIcon('<polygon points="13,2 5,13 10,13 8,22 18,9 12,9"/>') },
  { id: 'rupture', name: 'RUPTURE', cond: 'Terminer le niveau 3',
    icon: trophIcon('<polygon points="12,2 20,7 20,17 12,22 4,17 4,7"/><polyline points="12,2 10,9 14,13 11,17 12,22"/>') },
  { id: 'ninja', name: 'NINJA', cond: 'Terminer le niveau 4',
    icon: trophIcon('<path d="M3 12 h18 M12 3 v18"/><polygon points="12,3 15,9 21,12 15,15 12,21 9,15 3,12 9,9"/>') },
  { id: 'singularity', name: 'SINGULARITÉ', cond: 'Terminer le niveau 5',
    icon: trophIcon('<circle cx="12" cy="12" r="3.5"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-20 12 12)"/><path d="M12 2 v3 M12 19 v3"/>') },
  { id: 'flawless', name: 'SANS FAUTE', cond: 'Terminer un niveau officiel sans mourir (1 tentative)',
    icon: trophIcon('<polygon points="12,2 19,8 12,22 5,8"/><polyline points="5,8 12,11 19,8"/><line x1="12" y1="11" x2="12" y2="22"/>') },
  { id: 'collector', name: 'COLLECTIONNEUR', cond: 'Les 3 pièces d\'un même niveau',
    icon: trophIcon('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>') },
  { id: 'coin-hunter', name: 'CHASSEUR DE PIÈCES', cond: '9 pièces cumulées',
    icon: trophIcon('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>') },
  { id: 'creator', name: 'CRÉATEUR', cond: 'Enregistrer un premier niveau',
    icon: trophIcon('<path d="M14.5 6.5 a4 4 0 0 0 -5.6 5.6 L3 18 v3 h3 l5.9 -5.9 a4 4 0 0 0 5.6 -5.6 l-2.8 2.8 -2.1 -2.1 z"/>') },
  { id: 'architect', name: 'ARCHITECTE', cond: 'Enregistrer un niveau de 60 objets ou plus',
    icon: trophIcon('<path d="M3 21 h18 M5 21 V10 l4 -3 v14 M9 21 V7 l5 3 v11 M14 21 V9 l5 -2 v14"/><line x1="6" y1="12" x2="8" y2="12"/><line x1="11" y1="12" x2="13" y2="12"/><line x1="16" y1="12" x2="18" y2="12"/>') },
  { id: 'grinder', name: 'PERSÉVÉRANT', cond: '100 tentatives au total',
    icon: trophIcon('<path d="M12 21 C5 15 3 10 6 7 c2 -2 5 -1 6 1 c1 -2 4 -3 6 -1 c3 3 1 8 -6 14 z"/>') },
  { id: 'marathon', name: 'MARATHON', cond: '5 000 sauts au total',
    icon: trophIcon('<path d="M12 3 c1 4 -3 5 -3 9 a5 5 0 0 0 10 0 c0 -2 -1 -3 -2 -4 c0 2 -1 3 -2 3 c1 -3 -1 -6 -3 -8 z"/>') }
];

var toastQueue = [];   // file d'attente des toasts trophée (ids)
var toastT = 0;        // chronomètre du toast courant

function unlock(id) {
  if (store.trophies[id]) return;
  store.trophies[id] = new Date().toISOString();
  save();
  toastQueue.push(id);
  audio.sfxTrophy();
}

function officialDone() {
  var n = 0;
  if (store.levels.l1.best >= 100) n++;
  if (store.levels.l2.best >= 100) n++;
  if (store.levels.l3.best >= 100) n++;
  if (store.levels.l4.best >= 100) n++;
  if (store.levels.l5.best >= 100) n++;
  var demo = findCustom('demo');
  if (demo && demo.best >= 100) n++;
  return n;
}

/* evt = { win: true } quand appelé depuis winGame */
function checkTrophies(evt) {
  var i, rec, ok;
  // Complétions (état persistant — best ne monte à 100 qu'en mode normal)
  if (store.levels.l1.best >= 100) unlock('baseline');
  if (store.levels.l2.best >= 100) unlock('overdrive');
  if (store.levels.l3.best >= 100) unlock('rupture');
  if (store.levels.l4.best >= 100) unlock('ninja');
  if (store.levels.l5.best >= 100) unlock('singularity');
  var demo = findCustom('demo');
  if (demo && demo.best >= 100) unlock('first-steps');
  // Sans faute : victoire de la tentative en cours, 1 seule tentative, niveau officiel
  if (evt && evt.win && !practice && !testing && attempts === 1 &&
      (!cur.custom || cur.id === 'demo')) unlock('flawless');
  // Pièces
  var total = 0, full = false;
  var sets = [store.levels.l1.coins, store.levels.l2.coins, store.levels.l3.coins, store.levels.l4.coins, store.levels.l5.coins];
  for (i = 0; i < store.custom.length; i++) sets.push(store.custom[i].coins);
  for (i = 0; i < sets.length; i++) {
    var c = sets[i], n = 0;
    for (var j = 0; j < 3; j++) if (c && c[j]) n++;
    total += n;
    if (n === 3) full = true;
  }
  if (full) unlock('collector');
  if (total >= 9) unlock('coin-hunter');
  // Éditeur (la démo semée ne compte pas)
  ok = false;
  for (i = 0; i < store.custom.length; i++) {
    rec = store.custom[i];
    if (rec.id === 'demo') continue;
    ok = true;
    if (rec.objects && rec.objects.length >= 60) { unlock('architect'); break; }
  }
  if (ok) unlock('creator');
  // Cumuls
  if (store.attempts >= 100) unlock('grinder');
  if (store.jumps >= 5000) unlock('marathon');
}

/* Toast canvas : bannière glissante, 2,5 s, file d'attente */
function drawToast(dt) {
  if (!toastQueue.length) return;
  toastT += dt;
  if (toastT > 2.5) { toastQueue.shift(); toastT = 0; return; }
  var t = TROPHIES.filter(function (x) { return x.id === toastQueue[0]; })[0];
  if (!t) { toastQueue.shift(); toastT = 0; return; }
  var slideIn = Math.min(1, toastT / 0.35);
  var slideOut = toastT > 2.15 ? (toastT - 2.15) / 0.35 : 0;
  var ease = 1 - Math.pow(1 - slideIn, 3);
  var y = -80 + (ease * 96) - (slideOut * slideOut * 96);
  var w = 470, h = 64, x = (VW - w) / 2;
  ctx.save();
  ctx.globalAlpha = 0.97;
  ctx.fillStyle = '#050508';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COL.lime;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = COL.lime;
  ctx.fillRect(x, y, 5, h);
  ctx.font = '13px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = COL.white;
  ctx.fillText('TROPHÉE DÉBLOQUÉ', x + 20, y + 24);
  ctx.font = '26px Impact, "Arial Black", sans-serif';
  ctx.fillStyle = COL.lime;
  ctx.fillText(t.name, x + 20, y + 51);
  // Étoile à droite
  ctx.translate(x + w - 42, y + 32);
  ctx.strokeStyle = COL.lime;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (var i = 0; i < 10; i++) {
    var r = i % 2 ? 8 : 17, a = -Math.PI / 2 + i * Math.PI / 5;
    var px = Math.cos(a) * r, py = Math.sin(a) * r;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/* Panneau TROPHÉES (DOM) */
function renderTrophies() {
  var box = $('trophList');
  box.innerHTML = '';
  var unlocked = 0;
  TROPHIES.forEach(function (t) {
    var iso = store.trophies[t.id];
    if (iso) unlocked++;
    var d = document.createElement('div');
    d.className = 'troph-badge ' + (iso ? 'on' : 'off');
    var html = t.icon + '<div class="tb-name">' + t.name + '</div>';
    if (iso) {
      var dt = new Date(iso);
      html += '<div class="tb-date">DÉBLOQUÉ LE ' +
        ('0' + dt.getDate()).slice(-2) + '/' + ('0' + (dt.getMonth() + 1)).slice(-2) + '/' + dt.getFullYear() + '</div>';
    } else {
      html += '<div class="tb-cond">' + t.cond + '</div>';
    }
    d.innerHTML = html;
    box.appendChild(d);
  });
  $('trophCount').textContent = unlocked + '/' + TROPHIES.length;
  $('trophStats').textContent =
    'TENTATIVES ' + fmtNum(store.attempts) + ' · SAUTS ' + fmtNum(store.jumps) +
    ' · MORTS ' + fmtNum(store.deaths) + ' · NIVEAUX TERMINÉS ' + officialDone() + '/6';
}

function die() {
  if (state !== 'playing') return;
  state = 'dead';
  p.dead = true;
  deathT = 0; shakeT = 0.2;
  explode();
  audio.sfxDeath();
  if (!practice && !testing) {
    var pc = Math.floor(p.x / cur.length * 100);
    if (pc > curSave().best) { curSave().best = pc; }
    mpSubmitScore(pc, null);
  }
  if (!testing) store.deaths++;
  save();
  checkTrophies();
}

function respawn() {
  attempts++;
  store.attempts++;
  save();
  var sx = 0, sy = GY - 40, sm = 'cube', sg = 1, sf = 1, sclk = 0;
  if (practice && cps.length) {
    var c = cps[cps.length - 1];
    sx = c.x; sy = c.y; sm = c.mode; sg = c.gs; sf = c.sf || 1; sclk = c.clk || 0;
  }
  p.x = sx; p.y = sy; p.vy = 0; p.prevX = sx; p.prevY = sy;
  p.dead = false;
  mode = sm; gravitySign = sg; rot = 0; onGround = true;
  for (var i = 0; i < portals.length; i++) portals[i].used = portals[i].x < p.x;
  for (var j = 0; j < orbs.length; j++) { orbs[j].used = orbs[j].x < p.x; orbs[j].fx = 0; }
  runSpeed = cur.speed * sf; lvlClock = sclk; waveTrail = [];
  if (relPending) { held = false; relPending = false; }   // tape relâchée pendant la mort
  updateMovingSaws();
  camX = Math.max(0, p.x - PLAYER_X);
  attemptTime = 0;
  state = 'playing';
  flash('TENTATIVE ' + attempts);
  audio.startMusic(cur.bpm, cur.music);
  audio.bpm = cur.bpm * sf;          // la musique suit la vitesse (portails de vitesse)
}

function startGame() {
  audio.ensure();
  practice = !!elPractice.checked;
  testing = false;
  loadLevel(selectedLevel);
  attempts = 0; jumpsRun = 0; cps = [];
  winShown = false; winT = 0;
  hideEl(elMenu); hideEl(elWin); hideEl(elPause); hideEl(elEditor); hideEl(elMyLevels);
  hideEl(elTrophies); hideEl(elBoard); hideEl(elPublic);
  respawn();
}

function pauseGame() {
  if (state !== 'playing') return;
  state = 'paused';
  $('pLevel').textContent = cur.name + ' — ' + cur.sub;
  showEl(elPause);
  updateSoundLabel();
  if (audio.ctx) audio.ctx.suspend();
}

function resumeGame() {
  if (state !== 'paused') return;
  state = 'playing';
  hideEl(elPause);
  audio.ensure();
}

function toMenu() {
  state = 'menu';
  testing = false;
  audio.stopMusic();
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  save();
  hideEl(elPause); hideEl(elWin); hideEl(elEditor); hideEl(elMyLevels);
  hideEl(elExportModal); hideEl(elImportModal); hideEl(elTrophies); hideEl(elBoard); hideEl(elPublic);
  updateMenuStats();
  showEl(elMenu);
}

function showWinOnce() {
  if (winShown) return;
  winShown = true;
  $('wLevel').textContent = cur.name + ' — ' + cur.sub;
  $('wSpecial').textContent =
    cur.id === 'l5' ? 'SINGULARITÉ ATTEINTE — TU AS PLIÉ L\'ESPACE-TEMPS !' :
    cur.id === 'l4' ? 'MAÎTRE NINJA — LA TOUR EST CONQUISE !' :
    cur.id === 'l3' ? 'INCROYABLE — LE NIVEAU EXTRÊME EST TOMBÉ !' :
    (cur.id === 'l2' ? 'FÉLICITATIONS — NIVEAU DIFFICILE VAINCU !' : '');
  $('wAtt').textContent = attempts;
  $('wJump').textContent = jumpsRun;
  var sv = curSave(), nc = 0;
  for (var i = 0; i < 3; i++) if (sv.coins[i]) nc++;
  $('wCoins').textContent = nc + '/3';
  $('wTime').textContent = attemptTime.toFixed(1) + ' s';
  $('wRank').textContent = mpWinRankText();
  showEl(elWin);
}

function winGame() {
  if (state !== 'playing') return;
  state = 'win';
  winT = 0;
  audio.stopMusic();
  audio.sfxWin();
  if (testing) {
    flash('TEST TERMINÉ !');
    return;
  }
  if (!practice) { curSave().best = 100; }
  mpSubmitScore(100, attemptTime);
  save();
  checkTrophies({ win: true });
}

function backToEditor() {
  state = 'editor';
  testing = false;
  audio.stopMusic();
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  hideEl(elPause); hideEl(elWin); hideEl(elMenu);
  edRebuild();
  showEl(elEditor);
  edMsg('Retour à l\'éditeur — niveau conservé.');
}

function toggleMute() {
  store.muted = !store.muted;
  save();
  if (audio.master) audio.master.gain.value = store.muted ? 0 : 1;
  updateSoundLabel();
}

function updateSoundLabel() {
  $('btnSound').textContent = 'SON : ' + (store.muted ? 'NON' : 'OUI');
}

function selectLevel(idx) {
  var n = levelList().length;
  selectedLevel = Math.max(0, Math.min(n - 1, idx));
  rebuildMenuCards();
}

function fmtNum(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function rebuildMenuCards() {
  var box = $('cards');
  box.innerHTML = '';
  var list = levelList();
  list.forEach(function (lvl, i) {
    var sv = lvl.custom ? (findCustom(lvl.id) || { best: 0, coins: [false, false, false] }) : store.levels[lvl.id];
    var nc = 0;
    for (var j = 0; j < 3; j++) if (sv.coins[j]) nc++;
    var card = document.createElement('div');
    card.className = 'level-card' + (i === selectedLevel ? ' sel' : '');
    var diffCls = lvl.diff === 'DÉMON' ? 'd-demon' : lvl.diff === 'EXTRÊME' ? 'd-extreme' :
      (lvl.diff === 'DIFFICILE' ? 'd-hard' : (lvl.diff === 'CUSTOM' ? 'd-custom' : 'd-normal'));
    card.innerHTML =
      '<div class="lc-name">' + lvl.name + '</div>' +
      '<div class="lc-sub">' + lvl.sub + '</div>' +
      '<div class="lc-diff ' + diffCls + '">' + lvl.diff + '</div>' +
      '<div class="lc-stats"><span>MEILLEUR <b>' + Math.floor(sv.best) + '%</b></span>' +
      '<span>PIÈCES <b>' + nc + '/3</b></span></div>';
    card.addEventListener('click', function () { selectLevel(i); });
    box.appendChild(card);
  });
}

function updateMenuStats() {
  rebuildMenuCards();
  $('stAtt').textContent = store.attempts;
}

function addCheckpoint() {
  cps.push({ x: p.x, y: p.y, mode: mode, gs: gravitySign, sf: runSpeed / cur.speed, clk: lvlClock });
  audio.sfxCheckpoint();
  spawnP({ x: p.x + 20, y: p.y + 20, vx: 0, vy: -120 * gravitySign, life: 0.4, size: 6, col: COL.lime, g: 0 });
}

function removeCheckpoint() {
  if (cps.length) { cps.pop(); audio.sfxCheckpoint(); }
}

/* ============================================================
   ÉDITEUR DE NIVEAUX
   ============================================================ */
var ed = {
  objects: [],
  cam: 0,
  tool: 'spike',
  id: null,
  undoStack: [], redoStack: [],
  dragging: false, dragStart: null, dragCells: [],
  panning: false, panStart: null,
  mouse: { x: 0, y: 0, inside: false }
};
var edPreview = { id: '__edit', name: 'APERÇU', sub: '', diff: 'CUSTOM', bpm: 140, speed: 540, music: MUSIC_L1, custom: true, objects: [] };
var toolButtons = [];

var TOOLS = [
  { id: 'spike', fr: 'Pic', col: COL.coral, svg: '<svg viewBox="0 0 26 26"><path d="M4 22 L13 5 L22 22 Z" fill="currentColor"/></svg>' },
  { id: 'spikeCeil', fr: 'Pic plafond', col: COL.coral, svg: '<svg viewBox="0 0 26 26"><path d="M4 4 L13 21 L22 4 Z" fill="currentColor"/></svg>' },
  { id: 'block', fr: 'Bloc', col: COL.blue, svg: '<svg viewBox="0 0 26 26"><rect x="4" y="4" width="18" height="18" fill="currentColor"/><rect x="8" y="8" width="10" height="10" fill="rgba(255,255,255,.35)"/></svg>' },
  { id: 'pad', fr: 'Pad', col: COL.lime, svg: '<svg viewBox="0 0 26 26"><ellipse cx="13" cy="18" rx="10" ry="5" fill="none" stroke="currentColor" stroke-width="3"/></svg>' },
  { id: 'padCeil', fr: 'Pad plafond', col: COL.lime, svg: '<svg viewBox="0 0 26 26"><line x1="3" y1="4" x2="23" y2="4" stroke="currentColor" stroke-width="2"/><ellipse cx="13" cy="8" rx="10" ry="5" fill="none" stroke="currentColor" stroke-width="3"/></svg>' },
  { id: 'saw', fr: 'Scie', col: COL.coral, svg: '<svg viewBox="0 0 26 26"><circle cx="13" cy="13" r="7" fill="currentColor"/><g stroke="currentColor" stroke-width="3"><line x1="13" y1="1" x2="13" y2="6"/><line x1="13" y1="20" x2="13" y2="25"/><line x1="1" y1="13" x2="6" y2="13"/><line x1="20" y1="13" x2="25" y2="13"/><line x1="4" y1="4" x2="8" y2="8"/><line x1="18" y1="18" x2="22" y2="22"/><line x1="22" y1="4" x2="18" y2="8"/><line x1="8" y1="18" x2="4" y2="22"/></g></svg>' },
  { id: 'portalCube', fr: 'Portail cube', col: COL.blue, svg: '<svg viewBox="0 0 26 26"><rect x="8" y="2" width="10" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="3"/></svg>' },
  { id: 'portalShip', fr: 'Portail vaisseau', col: COL.lime, svg: '<svg viewBox="0 0 26 26"><rect x="8" y="2" width="10" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M16 13 L10 9 L12 13 L10 17 Z" fill="currentColor"/></svg>' },
  { id: 'portalGravDown', fr: 'Gravité ↓', col: COL.white, svg: '<svg viewBox="0 0 26 26"><rect x="8" y="2" width="10" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M13 8 L13 16 M9 13 L13 18 L17 13" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>' },
  { id: 'portalGravUp', fr: 'Gravité ↑', col: COL.white, svg: '<svg viewBox="0 0 26 26"><rect x="8" y="2" width="10" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M13 18 L13 10 M9 13 L13 8 L17 13" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>' },
  { id: 'coin', fr: 'Pièce', col: COL.lime, svg: '<svg viewBox="0 0 26 26"><circle cx="13" cy="13" r="9" fill="currentColor"/><circle cx="13" cy="13" r="4.5" fill="rgba(0,0,0,.35)"/></svg>' },
  { id: 'gate', fr: 'Porte d\'arrivée', col: COL.lime, svg: '<svg viewBox="0 0 26 26"><path d="M5 24 L5 4 L13 4 M21 24 L21 4 L13 4" fill="none" stroke="currentColor" stroke-width="3"/></svg>' },
  { id: 'orb', fr: 'Orbe saut', col: '#FFE14D', svg: '<svg viewBox="0 0 26 26"><circle cx="13" cy="13" r="9" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="13" cy="13" r="4" fill="currentColor"/></svg>' },
  { id: 'orbGrav', fr: 'Orbe gravité', col: COL.cyan, svg: '<svg viewBox="0 0 26 26"><circle cx="13" cy="13" r="10" fill="none" stroke="currentColor" stroke-width="3"/><path d="M9 11 L13 6 L17 11 Z M9 15 L13 20 L17 15 Z" fill="currentColor"/></svg>' },
  { id: 'portalWave', fr: 'Portail onde', col: COL.pink, svg: '<svg viewBox="0 0 26 26"><rect x="8" y="2" width="10" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11 7 L15 11 L11 15 L15 19" fill="none" stroke="currentColor" stroke-width="2"/></svg>' },
  { id: 'speedSlow', fr: 'Vitesse ×0.8', col: COL.cyan, svg: '<svg viewBox="0 0 26 26"><path d="M16 4 L8 13 L16 22" fill="none" stroke="currentColor" stroke-width="3.5"/></svg>' },
  { id: 'speedNormal', fr: 'Vitesse ×1', col: COL.white, svg: '<svg viewBox="0 0 26 26"><path d="M10 4 L18 13 L10 22" fill="none" stroke="currentColor" stroke-width="3.5"/></svg>' },
  { id: 'speedFast', fr: 'Vitesse ×1.3', col: COL.amber, svg: '<svg viewBox="0 0 26 26"><path d="M4 4 L11 13 L4 22 M11 4 L18 13 L11 22 M18 4 L25 13 L18 22" fill="none" stroke="currentColor" stroke-width="3"/></svg>' },
  { id: 'gomme', fr: 'Gomme', col: COL.white, svg: '<svg viewBox="0 0 26 26"><path d="M6 6 L20 20 M20 6 L6 20" stroke="currentColor" stroke-width="4"/></svg>' }
];

function snapCell(v) { return Math.max(0, Math.floor(v / 40)); }
function snapRow(v) { return Math.max(2, Math.min(10, Math.floor(v / 40))); }

function edSpeed() { return parseInt($('edSpeed').value, 10) || 540; }
function updateSpeedLabel() { $('edSpeedVal').textContent = edSpeed() + ' px/s'; }
function edBpm() { return parseInt($('edBpm').value, 10) || 140; }
function edName() { return ($('edName').value || '').trim().toUpperCase() || 'SANS NOM'; }

function edCountCoins() {
  var n = 0;
  for (var i = 0; i < ed.objects.length; i++) if (ed.objects[i].t === 'coin') n++;
  return n;
}
function edHasGate() {
  for (var i = 0; i < ed.objects.length; i++) if (ed.objects[i].t === 'gate') return true;
  return false;
}

function edPushUndo(action) {
  ed.undoStack.push(action);
  if (ed.undoStack.length > 100) ed.undoStack.shift();
  ed.redoStack = [];
}
function edApplyAdd(objs) {
  for (var i = 0; i < objs.length; i++) ed.objects.push(objs[i]);
}
function edApplyDel(objs) {
  for (var i = 0; i < objs.length; i++) {
    var k = ed.objects.indexOf(objs[i]);
    if (k >= 0) ed.objects.splice(k, 1);
  }
}
function edUndo() {
  var a = ed.undoStack.pop();
  if (!a) return;
  edApplyDel(a.add || []);
  edApplyAdd(a.del || []);
  ed.redoStack.push(a);
  edRebuild();
}
function edRedo() {
  var a = ed.redoStack.pop();
  if (!a) return;
  edApplyDel(a.del || []);
  edApplyAdd(a.add || []);
  ed.undoStack.push(a);
  edRebuild();
}

function edExists(t, x, y) {
  for (var i = 0; i < ed.objects.length; i++) {
    var o = ed.objects[i];
    if (o.t === t && o.x === x && o.y === y) return true;
  }
  return false;
}

function edMakeObj(tool, wx, wy) {
  var cx = snapCell(wx), ry = snapRow(wy);
  switch (tool) {
    case 'spike': return { t: 'spike', x: cx * 40, y: GY };
    case 'spikeCeil': return { t: 'spikeCeil', x: cx * 40, y: CY };
    case 'block': return { t: 'block', x: cx * 40, y: ry * 40, w: 40, h: 40 };
    case 'pad': return { t: 'pad', x: cx * 40, y: GY };
    case 'padCeil': return { t: 'padCeil', x: cx * 40, y: CY };
    case 'saw': return { t: 'saw', x: cx * 40 + 20, y: Math.max(CY + 24, Math.min(GY - 24, ry * 40 + 20)) };
    case 'portalCube': return { t: 'portalCube', x: cx * 40, y: 210 };
    case 'portalShip': return { t: 'portalShip', x: cx * 40, y: 210 };
    case 'portalGravDown': return { t: 'portalGravDown', x: cx * 40, y: 60 };
    case 'portalGravUp': return { t: 'portalGravUp', x: cx * 40, y: 60 };
    case 'coin': return { t: 'coin', x: cx * 40 + 20, y: Math.max(CY + 20, Math.min(GY - 20, ry * 40 + 20)) };
    case 'gate': return { t: 'gate', x: cx * 40, y: GY };
    case 'orb': case 'orbGrav':
      return { t: tool, x: cx * 40 + 20, y: Math.max(CY + 20, Math.min(GY - 20, ry * 40 + 20)) };
    case 'portalWave': case 'speedSlow': case 'speedNormal': case 'speedFast':
      return { t: tool, x: cx * 40, y: 210 };
  }
  return null;
}

function edPlaceAt(wx, wy) {
  var obj = edMakeObj(ed.tool, wx, wy);
  if (!obj) return;
  if (obj.t === 'coin' && edCountCoins() >= 3) {
    edMsg('Maximum 3 pièces par niveau.');
    return;
  }
  var del = [];
  if (obj.t === 'gate') {
    for (var i = 0; i < ed.objects.length; i++) if (ed.objects[i].t === 'gate') del.push(ed.objects[i]);
  }
  if (edExists(obj.t, obj.x, obj.y)) return;
  edApplyDel(del);
  edApplyAdd([obj]);
  edPushUndo({ add: [obj], del: del });
  edRebuild();
}

function edObjBBox(o) {
  switch (o.t) {
    case 'spike': return { x: o.x, y: GY - 40, w: 40, h: 40 };
    case 'spikeCeil': return { x: o.x, y: CY, w: 40, h: 40 };
    case 'pad': return { x: o.x, y: GY - 14, w: 36, h: 14 };
    case 'padCeil': return { x: o.x, y: CY, w: 36, h: 14 };
    case 'block': return { x: o.x, y: o.y, w: o.w, h: o.h };
    case 'saw': return { x: o.x - 30, y: o.y - 30, w: 60, h: 60 };
    case 'coin': return { x: o.x - 15, y: o.y - 15, w: 30, h: 30 };
    case 'gate': return { x: o.x, y: GY - 170, w: 70, h: 170 };
    case 'orb': case 'orbGrav': return { x: o.x - 20, y: o.y - 20, w: 40, h: 40 };
    default: return { x: o.x, y: 60, w: 34, h: GY - 60 };  // portails
  }
}
function edHitAt(wx, wy) {
  for (var i = ed.objects.length - 1; i >= 0; i--) {
    var b = edObjBBox(ed.objects[i]);
    if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return ed.objects[i];
  }
  return null;
}
function edEraseAt(wx, wy) {
  var o = edHitAt(wx, wy);
  if (!o) return;
  edApplyDel([o]);
  edPushUndo({ add: [], del: [o] });
  edRebuild();
}

function edCommitBlockDrag(wx, wy) {
  var c0 = Math.min(ed.dragStart.cx, snapCell(wx)), c1 = Math.max(ed.dragStart.cx, snapCell(wx));
  var r0 = Math.min(ed.dragStart.cy, snapRow(wy)), r1 = Math.max(ed.dragStart.cy, snapRow(wy));
  var obj = { t: 'block', x: c0 * 40, y: r0 * 40, w: (c1 - c0 + 1) * 40, h: (r1 - r0 + 1) * 40 };
  edApplyAdd([obj]);
  edPushUndo({ add: [obj], del: [] });
  edRebuild();
}
function edCommitRowDrag(wx) {
  var c1 = snapCell(wx);
  var lo = Math.min(ed.dragStart.cx, c1), hi = Math.max(ed.dragStart.cx, c1);
  var added = [];
  for (var c = lo; c <= hi; c++) {
    var t = ed.tool === 'spikeCeil' ? 'spikeCeil' : 'spike';
    var y = t === 'spikeCeil' ? CY : GY;
    if (!edExists(t, c * 40, y)) {
      var o = { t: t, x: c * 40, y: y };
      ed.objects.push(o);
      added.push(o);
    }
  }
  if (added.length) edPushUndo({ add: added, del: [] });
  edRebuild();
}

/* Reconstruit l'aperçu runtime de l'éditeur */
function edRebuild() {
  edPreview.speed = edSpeed();
  edPreview.bpm = edBpm();
  edPreview.music = edBpm() === 160 ? MUSIC_L2 : MUSIC_L1;
  edPreview.objects = ed.objects;
  resetLevelData();
  var savedCur = cur;
  cur = edPreview;
  loadObjects(ed.objects);
  cur = savedCur;
  // longueur affichée / scrollbar
  var maxX = 10000;
  for (var i = 0; i < ed.objects.length; i++) maxX = Math.max(maxX, ed.objects[i].x + 1500);
  var sc = $('edScroll');
  sc.max = maxX;
  if (ed.cam > maxX) ed.cam = maxX;
  sc.value = Math.round(ed.cam);
  // outil pièce désactivé au-delà de 3
  for (var j = 0; j < toolButtons.length; j++) {
    if (toolButtons[j].id === 'coin') {
      toolButtons[j].el.classList.toggle('off', edCountCoins() >= 3);
    }
  }
  edUpdatePos();
}

function edUpdatePos() {
  $('edPos').textContent = 'x = ' + fmtNum(ed.cam) + ' px (~' + Math.round(ed.cam / edSpeed()) + ' s)';
}

function edSetTool(id) {
  ed.tool = id;
  for (var i = 0; i < toolButtons.length; i++) {
    toolButtons[i].el.classList.toggle('sel', toolButtons[i].id === id);
  }
}

function edBuildToolbar() {
  var box = $('edTools');
  box.innerHTML = '';
  toolButtons = [];
  TOOLS.forEach(function (t) {
    var b = document.createElement('button');
    b.className = 'ed-tool' + (t.id === ed.tool ? ' sel' : '');
    b.innerHTML = t.svg + '<span>' + t.fr + '</span>';
    b.style.color = t.col;
    b.title = t.fr;
    b.addEventListener('click', function () { edSetTool(t.id); });
    box.appendChild(b);
    toolButtons.push({ id: t.id, el: b });
  });
}

function editorNew() {
  ed.objects = [];
  ed.id = null;
  ed.cam = 0;
  ed.tool = 'spike';
  ed.undoStack = []; ed.redoStack = [];
  $('edName').value = 'MON NIVEAU';
  $('edSpeed').value = '540';
  updateSpeedLabel();
  $('edBpm').value = '140';
  edSetTool('spike');
  edRebuild();
}

function enterEditor() {
  state = 'editor';
  testing = false;
  hideEl(elMenu); hideEl(elPause); hideEl(elWin); hideEl(elMyLevels);
  edRebuild();
  showEl(elEditor);
}

function editorTest() {
  if (!ed.objects.length) {
    edMsg('Niveau vide — placez des objets d\'abord.');
    return;
  }
  if (!edHasGate()) {
    edMsg('Pas de porte d\'arrivée : le test finira 1500 px après le dernier objet.');
  }
  audio.ensure();
  testing = true;
  practice = false;
  loadLevelData({
    id: '__test', name: edName(), sub: 'TEST', diff: 'CUSTOM',
    bpm: edBpm(), speed: edSpeed(), music: edBpm() === 160 ? MUSIC_L2 : MUSIC_L1,
    custom: true, objects: ed.objects.slice()
  });
  attempts = 0; jumpsRun = 0; cps = [];
  winShown = false; winT = 0;
  hideEl(elEditor); hideEl(elMenu); hideEl(elWin); hideEl(elPause);
  respawn();
}

function editorSave() {
  if (!ed.objects.length) {
    edMsg('Niveau vide — rien à enregistrer.');
    return null;
  }
  var rec = ed.id ? findCustom(ed.id) : null;
  if (rec) {
    rec.name = edName();
    rec.speed = edSpeed();
    rec.bpm = edBpm();
    rec.objects = ed.objects.slice();
  } else {
    rec = {
      id: 'c' + Date.now(), name: edName(), speed: edSpeed(), bpm: edBpm(),
      objects: ed.objects.slice(), createdAt: Date.now(), best: 0, coins: [false, false, false]
    };
    store.custom.push(rec);
    ed.id = rec.id;
  }
  save();
  checkTrophies();
  rebuildMenuCards();
  edMsg('Niveau enregistré ✔');
  return rec;
}

function loadCustomIntoEditor(id) {
  var rec = findCustom(id);
  if (!rec) return false;
  ed.id = rec.id;
  ed.objects = rec.objects.slice();
  ed.cam = 0;
  ed.undoStack = []; ed.redoStack = [];
  $('edName').value = rec.name;
  $('edSpeed').value = String(rec.speed);
  updateSpeedLabel();
  $('edBpm').value = String(rec.bpm);
  edSetTool('spike');
  hideEl(elMyLevels);
  enterEditor();
  edMsg('Niveau chargé dans l\'éditeur.');
  return true;
}

/* Export / Import */
function exportJSON(id) {
  var rec = typeof id === 'string' ? findCustom(id) : id;
  if (!rec) return '';
  return JSON.stringify({ v: 1, name: rec.name, speed: rec.speed, bpm: rec.bpm, objects: rec.objects });
}

function importJSON(text) {
  function err(m) { return { ok: false, err: m }; }
  var o;
  try { o = JSON.parse(text); } catch (e) { return err('JSON illisible : ' + e.message); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return err('Structure invalide (objet attendu).');
  if (typeof o.speed !== 'number' || !isFinite(o.speed) || o.speed < 360 || o.speed > 820) return err('Vitesse invalide (360 à 820 px/s attendue).');
  if (o.bpm !== 140 && o.bpm !== 160) return err('Musique invalide (140 ou 160 attendue).');
  if (!Array.isArray(o.objects)) return err('Champ « objects » manquant.');
  if (o.objects.length < 1) return err('Le niveau est vide.');
  if (o.objects.length > 2000) return err('Trop d\'objets (max 2000).');
  var nbCoins = 0, nbGates = 0, clean = [];
  for (var i = 0; i < o.objects.length; i++) {
    var ob = o.objects[i];
    if (!ob || typeof ob !== 'object') return err('Objet #' + i + ' invalide.');
    if (!OBJ_TYPES[ob.t]) return err('Type d\'objet inconnu : « ' + ob.t + ' ».');
    if (typeof ob.x !== 'number' || !isFinite(ob.x) || ob.x < 0 || ob.x > 200000) return err('Objet #' + i + ' : coordonnée x invalide.');
    if (typeof ob.y !== 'number' || !isFinite(ob.y) || ob.y < 0 || ob.y > 540) return err('Objet #' + i + ' : coordonnée y invalide.');
    var c = { t: ob.t, x: ob.x, y: ob.y };
    if (ob.t === 'block') {
      if (typeof ob.w !== 'number' || typeof ob.h !== 'number' ||
          ob.w < 20 || ob.h < 20 || ob.w > 2400 || ob.h > 2400) {
        return err('Objet #' + i + ' : bloc invalide (w/h entre 20 et 2400 px).');
      }
      c.w = ob.w; c.h = ob.h;
    }
    if (ob.t === 'coin') { nbCoins++; if (nbCoins > 3) return err('Trop de pièces (max 3).'); }
    if (ob.t === 'gate') { nbGates++; if (nbGates > 1) return err('Plus d\'une porte d\'arrivée.'); }
    clean.push(c);
  }
  var rec = {
    id: 'c' + Date.now(),
    name: (typeof o.name === 'string' && o.name.trim() ? o.name.trim().toUpperCase().slice(0, 24) : 'NIVEAU IMPORTÉ'),
    speed: o.speed, bpm: o.bpm, objects: clean,
    createdAt: Date.now(), best: 0, coins: [false, false, false]
  };
  store.custom.push(rec);
  save();
  checkTrophies();
  rebuildMenuCards();
  return { ok: true, rec: rec };
}

/* Panneau MES NIVEAUX */
function renderMyLevels() {
  var box = $('mlList');
  box.innerHTML = '';
  $('mlResetDemo').classList.toggle('hidden', !!findCustom('demo'));
  if (!store.custom.length) {
    var empty = document.createElement('div');
    empty.className = 'ml-empty';
    empty.textContent = 'Aucun niveau personnalisé pour le moment.';
    box.appendChild(empty);
    return;
  }
  store.custom.forEach(function (rec) {
    var row = document.createElement('div');
    row.className = 'ml-row';
    var date = new Date(rec.createdAt);
    var info = document.createElement('div');
    info.className = 'ml-info';
    info.innerHTML = '<b>' + rec.name + '</b><span>' +
      ('0' + date.getDate()).slice(-2) + '/' + ('0' + (date.getMonth() + 1)).slice(-2) + '/' + date.getFullYear() +
      ' · ' + rec.objects.length + ' objets · ' + rec.speed + ' px/s · ' + Math.floor(rec.best) + '%</span>';
    row.appendChild(info);
    function mkBtn(label, cls, fn) {
      var b = document.createElement('button');
      b.className = 'btn sm ' + cls;
      b.textContent = label;
      b.addEventListener('click', fn);
      row.appendChild(b);
    }
    mkBtn('MODIFIER', '', function () { loadCustomIntoEditor(rec.id); });
    mkBtn('PUBLIER', '', function () { publishLevel(rec); });
    mkBtn('JOUER', '', function () {
      var idx = levelList().findIndex(function (l) { return l.id === rec.id; });
      if (idx >= 0) { selectedLevel = idx; hideEl(elMyLevels); startGame(); }
    });
    mkBtn('EXPORTER', '', function () {
      var json = exportJSON(rec.id);
      $('exportText').value = json;
      copyText(json);
      hideEl(elMyLevels);
      showEl(elExportModal);
    });
    mkBtn('SUPPRIMER', 'danger', function () {
      if (window.confirm('Supprimer définitivement « ' + rec.name + ' » ?')) {
        store.custom.splice(store.custom.indexOf(rec), 1);
        if (rec.id === 'demo') store.demoDeleted = true;
        save();
        rebuildMenuCards();
        renderMyLevels();
      }
    });
    box.appendChild(row);
  });
}

function copyText(t) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t);
    }
  } catch (e) { /* la modale affiche le JSON, copie manuelle possible */ }
}

/* ---------------- Physique (pas fixe 120 Hz) ---------------- */
/* Bannières de section (niveau 5) : annoncées au franchissement */
function checkBanners() {
  for (var i = 0; i < cur.banners.length; i++) {
    var bn = cur.banners[i];
    if (p.prevX < bn.x && p.x >= bn.x) flash(bn.text);
  }
}

function stepGame(dt) {
  if (orbBuf > 0) orbBuf--;
  attemptTime += dt;
  lvlClock += dt;
  sawRot += dt * 4;
  updateMovingSaws();
  var inset = (mode === 'ship') ? 3 : (mode === 'wave' ? WAVE_INSET : 0);
  var pw = 40 - inset * 2, ph = 40 - inset * 2;
  p.prevX = p.x; p.prevY = p.y;

  p.x += runSpeed * dt;
  if (cur.banners) checkBanners();

  if (mode === 'cube') {
    if (onGround && held) doJump();
    p.vy += GRAV * gravitySign * dt;
  } else if (mode === 'wave') {
    // Onde : diagonale à 45° — maintenu = monte, relâché = descend (relatif à la gravité)
    p.vy = (held ? -runSpeed : runSpeed) * gravitySign;
  } else {
    p.vy += SHIP_GRAV * gravitySign * dt;
    if (held) p.vy -= SHIP_THRUST * gravitySign * dt;
    if (p.vy > SHIP_CLAMP) p.vy = SHIP_CLAMP;
    if (p.vy < -SHIP_CLAMP) p.vy = -SHIP_CLAMP;
  }
  p.y += p.vy * dt;
  onGround = false;

  var hx = p.x + inset, hy = p.y + inset;

  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.x > p.x + 60 || b.x + b.w < p.x - 20) continue;
    if (hx < b.x + b.w && hx + pw > b.x && hy < b.y + b.h && hy + ph > b.y) {
      var prevBottom = p.prevY + inset + ph, prevTop = p.prevY + inset;
      if (gravitySign > 0) {
        if (prevBottom <= b.y + 0.5 && p.vy >= 0) {
          p.y = b.y - inset - ph; p.vy = 0; onGround = true;
          if (mode === 'cube') snapRot();
        } else if (prevTop >= b.y + b.h - 0.5 && p.vy < 0) {
          if (mode === 'cube') { die(); return; }
          p.y = b.y + b.h - inset; p.vy = 0;
        } else { die(); return; }
      } else {
        if (prevTop >= b.y + b.h - 0.5 && p.vy <= 0) {
          p.y = b.y + b.h - inset; p.vy = 0; onGround = true;
          if (mode === 'cube') snapRot();
        } else if (prevBottom <= b.y + 0.5 && p.vy > 0) {
          if (mode === 'cube') { die(); return; }
          p.y = b.y - inset - ph; p.vy = 0;
        } else { die(); return; }
      }
      hx = p.x + inset; hy = p.y + inset;
    }
  }

  var gIn = mode === 'wave' ? inset : 0;
  if (!inShipZone(p.x + 20) && p.y + 40 - gIn >= GY) {
    p.y = GY - 40 + gIn;
    if (p.vy > 0) p.vy = 0;
    onGround = true;
    if (mode === 'cube') snapRot();
  }
  // Plafond : zones codées (N1/N2) ou automatique (custom : vaisseau ou gravité inversée)
  var ceilSolid = gravitySign < 0 || inGravZone(p.x + 20) || (cur.custom && (mode === 'ship' || mode === 'wave'));
  if (p.y + gIn <= CY && ceilSolid) {
    p.y = CY - gIn;
    if (p.vy < 0) p.vy = 0;
    onGround = true;
    if (mode === 'cube') snapRot();
  }
  if (p.y > H + 120 || p.y < -200) { die(); return; }

  if (mode === 'cube') {
    if (!onGround) rot += dt * ROT_SPEED * gravitySign;
  } else if (mode === 'wave') {
    rot = Math.atan2(p.vy, runSpeed);
  } else {
    var target = (p.vy / SHIP_CLAMP) * 0.5 * gravitySign;
    rot += (target - rot) * Math.min(1, dt * 12);
  }

  hx = p.x + inset; hy = p.y + inset;

  for (var s2 = 0; s2 < spikes.length; s2++) {
    var sp = spikes[s2];
    if (sp.x > p.x + 60 || sp.x + 40 < p.x - 20) continue;
    if (hx < sp.hx + 24 && hx + pw > sp.hx && hy < sp.hy + 22 && hy + ph > sp.hy) { die(); return; }
  }

  for (var s3 = 0; s3 < saws.length; s3++) {
    var sw = saws[s3];
    if (sw.x > p.x + 100 || sw.x < p.x - 60) continue;
    var rr = sw.r * 0.7;
    var cx = Math.max(hx, Math.min(sw.x, hx + pw));
    var cy2 = Math.max(hy, Math.min(sw.y, hy + ph));
    var ddx = sw.x - cx, ddy = sw.y - cy2;
    if (ddx * ddx + ddy * ddy < rr * rr) { die(); return; }
  }

  for (var s4 = 0; s4 < pads.length; s4++) {
    var pd = pads[s4];
    if (pd.x > p.x + 60 || pd.x + 36 < p.x - 20) continue;
    if (hx < pd.x + 36 && hx + pw > pd.x && hy < pd.hy + 12 && hy + ph > pd.hy) {
      p.vy = pd.ceil ? -PAD_V : PAD_V;
      onGround = false;
      audio.sfxJump();
      spawnP({ x: pd.x + 18, y: pd.ceil ? pd.y + 6 : pd.y - 6, vx: -80, vy: pd.ceil ? 200 : -200, life: 0.3, size: 5, col: COL.lime, g: 0 });
    }
  }

  // Orbes (cube, une fois par tentative) : bouton maintenu en passant dessus, ou tape récente
  // (tampon ORB_BUF) — au tactile on tape souvent brièvement, juste avant l'orbe.
  if (mode === 'cube' && (held || orbBuf > 0)) {
    for (var so = 0; so < orbs.length; so++) {
      var ob = orbs[so];
      if (ob.used || ob.x > p.x + 80 || ob.x < p.x - 40) continue;
      if (Math.abs(ob.x - (p.x + 20)) < 34 && Math.abs(ob.y - (p.y + 20)) < 34) {
        ob.used = true; ob.fx = 1; orbBuf = 0;
        if (ob.kind === 'grav') {
          gravitySign = -gravitySign;
          p.vy = ORB_GRAV_V * gravitySign;
          audio.sfxGrav();
        } else {
          p.vy = ORB_V * gravitySign;
          jumpsRun++; store.jumps++;
          audio.sfxOrb();
        }
        onGround = false;
        for (var ob2 = 0; ob2 < 12; ob2++) {
          var oa = ob2 / 12 * Math.PI * 2;
          spawnP({ x: ob.x, y: ob.y, vx: Math.cos(oa) * 260, vy: Math.sin(oa) * 260, life: 0.3, size: 4, col: ob.kind === 'grav' ? COL.cyan : '#FFE14D', g: 0 });
        }
      }
    }
  }

  if (held) heldSteps++;
  if (relPending) { held = false; relPending = false; }

  for (var s5 = 0; s5 < portals.length; s5++) {
    var po = portals[s5];
    if (po.used || po.x > p.x + 60 || po.x + po.w < p.x) continue;
    if (hx < po.x + po.w && hx + pw > po.x && hy < po.y + po.h && hy + ph > po.y) {
      po.used = true;
      if (po.mode === 'grav') {
        gravitySign = po.dir;
        p.vy = 0;
        snapRot();
        audio.sfxGrav();
      } else if (po.mode === 'speed') {
        var faster = cur.speed * po.factor > runSpeed;
        runSpeed = cur.speed * po.factor;
        audio.bpm = cur.bpm * po.factor;     // la musique accélère / ralentit avec toi
        audio.sfxSpeed(faster);
        shakeT = Math.max(shakeT, 0.12);
      } else {
        mode = po.mode;
        p.vy = 0; rot = 0;
        waveTrail = [];
        audio.sfxPortal();
      }
      var burstCol = po.mode === 'ship' ? COL.lime : (po.mode === 'cube' ? COL.blue :
        (po.mode === 'wave' ? COL.pink : (po.mode === 'speed' ? COL.amber : COL.white)));
      for (var pb = 0; pb < 10; pb++) {
        spawnP({
          x: p.x + 20, y: p.y + 20,
          vx: -120 - Math.random() * 160, vy: (Math.random() - 0.5) * 320,
          life: 0.35, size: 4 + Math.random() * 3, col: burstCol, g: 0
        });
      }
    }
  }

  var svc = curSave().coins;
  for (var s6 = 0; s6 < coins.length; s6++) {
    var cn = coins[s6];
    if (svc[cn.id]) continue;
    var cdx = cn.x - (p.x + 20), cdy = cn.y - (p.y + 20);
    if (cdx * cdx + cdy * cdy < 900) {
      if (!testing) { svc[cn.id] = true; save(); checkTrophies(); }
      audio.sfxCoin();
      for (var cb2 = 0; cb2 < 8; cb2++) {
        spawnP({
          x: cn.x, y: cn.y,
          vx: (Math.random() - 0.5) * 300, vy: -80 - Math.random() * 160,
          life: 0.4, size: 3 + Math.random() * 3, col: COL.lime, g: 800
        });
      }
    }
  }

  trailAcc += dt;
  while (trailAcc > 0.016) {
    trailAcc -= 0.016;
    spawnP({
      x: p.x + 2, y: p.y + 20 + (Math.random() * 16 - 8),
      vx: -runSpeed * 0.25 - Math.random() * 60, vy: (Math.random() - 0.5) * 40,
      life: 0.28 + Math.random() * 0.15, size: 2.5 + Math.random() * 3,
      col: Math.random() < 0.6 ? COL.white : (mode === 'ship' ? COL.lime : (mode === 'wave' ? COL.pink : COL.blue)), g: 0
    });
  }
  if (mode === 'wave') {
    waveTrail.push(p.x + 20, p.y + 20);
    if (waveTrail.length > 180) waveTrail.splice(0, 2);
  }

  camX = Math.max(0, p.x - PLAYER_X);
  if (p.x >= cur.length) winGame();
}

function stepDead(dt) {
  deathT += dt;
  sawRot += dt * 4;
  lvlClock += dt;
  updateMovingSaws();
  if (deathT >= 0.5) respawn();
}

/* ---------------- Rendu ---------------- */
var dpr = 1, viewScale = 1;

/* navigator.maxTouchPoints > 0 est un faux positif fréquent sur laptops à
   touchpad précision (Windows) sans écran tactile : on préfère le pointeur
   d'entrée principal (pointer: coarse = doigt, pointer: fine = souris/trackpad). */
function isTouchDevice() {
  if (window.matchMedia) return window.matchMedia('(pointer: coarse)').matches;
  return ('ontouchstart' in window) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
}

/* matchMedia reflète l'orientation déjà stabilisée par le moteur du navigateur,
   plus fiable qu'un calcul pixel juste après une rotation. */
function isPortrait() {
  if (window.matchMedia) return window.matchMedia('(orientation: portrait)').matches;
  return window.innerHeight > window.innerWidth;
}

/* Letterbox : plus grand rectangle 960×540 (16:9) centré dans la zone VISIBLE.
   Source de vérité = visualViewport (barres navigateur mobiles exclues) ;
   repli sur window.innerWidth/innerHeight. Jamais de plafond d'échelle. */
function fit() {
  var vw = window.innerWidth, vh = window.innerHeight;
  if (window.visualViewport) {
    vw = Math.round(window.visualViewport.width);
    vh = Math.round(window.visualViewport.height);
  }
  if (!(vw > 0) || !(vh > 0)) { vw = W; vh = H; }
  var s = Math.min(vw / W, vh / H);
  if (!(s > 0) || !isFinite(s)) s = 1;
  viewScale = s;
  /* Écran plus large que 16:9 → on étend la vue jusqu'aux bords */
  VW = Math.max(W, Math.round(vw / s));
  canvas.style.width = (VW * s) + 'px';
  canvas.style.height = (H * s) + 'px';
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(VW * dpr);
  canvas.height = Math.round(H * dpr);
  /* Overlay rotation : tactile + portrait → on masque le jeu */
  elRotate.classList.toggle('show', isTouchDevice() && isPortrait());
}

function refit() {
  fit();
  setTimeout(fit, 60);
  setTimeout(fit, 350);
}
window.addEventListener('resize', fit);
/* iOS met à jour les dimensions APRÈS orientationchange → recalculs différés */
window.addEventListener('orientationchange', refit);
/* Les barres navigateur changent la zone visible sans resize classique */
if (window.visualViewport && window.visualViewport.addEventListener) {
  window.visualViewport.addEventListener('resize', fit);
}
/* Filet de sécurité : orientationchange est déprécié/peu fiable sur Safari récent */
if (window.matchMedia) {
  var mqPortrait = window.matchMedia('(orientation: portrait)');
  if (mqPortrait.addEventListener) mqPortrait.addEventListener('change', refit);
  else if (mqPortrait.addListener) mqPortrait.addListener(refit);
}
fit();

function drawDots(pulse) {
  var sp = 30;
  var off = -((camX * 0.15) % sp);
  ctx.fillStyle = 'rgba(243,243,243,' + (0.07 + pulse * 0.13).toFixed(3) + ')';
  var sz = 5 + pulse * 2.5;
  for (var x = off; x < VW + sp; x += sp) {
    for (var y = 15; y < H; y += sp) {
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
  }
}

function drawMountains() {
  var ox = camX * 0.3;
  ctx.strokeStyle = 'rgba(56,52,255,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (var i = 0; i < mountains.length; i++) {
    var m = mountains[i];
    var sx = m.x - ox;
    if (sx < -300 || sx > VW + 300) continue;
    ctx.moveTo(sx, GY);
    ctx.lineTo(sx + 130, GY - m.h);
    ctx.lineTo(sx + 260, GY);
  }
  ctx.stroke();
}

function drawFloatSquares() {
  var ox = camX * 0.6;
  for (var i = 0; i < floatSquares.length; i++) {
    var q = floatSquares[i];
    var sx = q.x - ox;
    if (sx < -60 || sx > VW + 60) continue;
    ctx.save();
    ctx.translate(sx, q.y);
    ctx.rotate(q.rot + tNow * 0.15);
    ctx.fillStyle = q.lime ? 'rgba(198,211,45,0.08)' : 'rgba(56,52,255,0.09)';
    ctx.fillRect(-q.sz / 2, -q.sz / 2, q.sz, q.sz);
    ctx.restore();
  }
}

function neonEdge(x0, x1, y) {
  ctx.save();
  ctx.strokeStyle = '#8F8CFF';
  ctx.lineWidth = 3;
  ctx.shadowColor = COL.blue;
  ctx.shadowBlur = 14;
  ctx.setLineDash([16, 18]);
  ctx.lineDashOffset = -((tNow * 140) % 34);
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.restore();
}

function drawGroundSeg(x0, x1) {
  var g = ctx.createLinearGradient(0, GY, 0, H);
  g.addColorStop(0, COL.deep);
  g.addColorStop(1, '#01063F');
  ctx.fillStyle = g;
  ctx.fillRect(x0, GY, x1 - x0, H - GY);
  neonEdge(x0, x1, GY);
  ctx.strokeStyle = 'rgba(243,243,243,0.16)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  var start = Math.floor((x0 - tNow * 140) / 34) * 34 + tNow * 140;
  for (var hx2 = start; hx2 < x1; hx2 += 34) {
    ctx.moveTo(hx2, GY + 8);
    ctx.lineTo(hx2 - 10, GY + 28);
  }
  ctx.stroke();
}

function drawCeilSeg(x0, x1) {
  var g = ctx.createLinearGradient(0, 0, 0, CY);
  g.addColorStop(0, '#01063F');
  g.addColorStop(1, COL.deep);
  ctx.fillStyle = g;
  ctx.fillRect(x0, 0, x1 - x0, CY);
  neonEdge(x0, x1, CY);
  ctx.strokeStyle = 'rgba(243,243,243,0.16)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  var start = Math.floor((x0 - tNow * 140) / 34) * 34 + tNow * 140;
  for (var hx2 = start; hx2 < x1; hx2 += 34) {
    ctx.moveTo(hx2, CY - 8);
    ctx.lineTo(hx2 - 10, CY - 28);
  }
  ctx.stroke();
}

function drawBlock(b) {
  ctx.fillStyle = COL.blue;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(b.x + 5, b.y + 5, b.w - 10, b.h - 10);
  ctx.save();
  ctx.strokeStyle = '#8F8CFF';
  ctx.lineWidth = 2;
  ctx.shadowColor = COL.blue;
  ctx.shadowBlur = 12;
  ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
  ctx.restore();
  if (b.floor) neonEdge(b.x, b.x + b.w, b.y);
  if (b.ceil) neonEdge(b.x, b.x + b.w, b.y + b.h);
}

function drawSpike(s) {
  ctx.save();
  ctx.shadowColor = COL.coral;
  ctx.shadowBlur = 12;
  ctx.fillStyle = COL.coral;
  ctx.beginPath();
  if (s.ceil) {
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + 20, s.y + 40);
    ctx.lineTo(s.x + 40, s.y);
  } else {
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + 20, s.y - 40);
    ctx.lineTo(s.x + 40, s.y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#FFB0A3';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawSaw(s) {
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(sawRot);
  ctx.shadowColor = COL.coral;
  ctx.shadowBlur = 14;
  ctx.fillStyle = COL.coral;
  for (var i = 0; i < 8; i++) {
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-4, -s.r - 8, 8, 12);
  }
  ctx.beginPath();
  ctx.arc(0, 0, s.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#8F1D10';
  ctx.beginPath();
  ctx.arc(0, 0, s.r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPad(pd) {
  ctx.save();
  ctx.strokeStyle = COL.lime;
  ctx.lineWidth = 5;
  ctx.shadowColor = COL.lime;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.ellipse(pd.x + 18, pd.ceil ? pd.y + 5 : pd.y - 5, 18, 7, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(198,211,45,0.25)';
  ctx.fill();
  ctx.restore();
}

function rrPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* Portail de vitesse : chevrons animés (ambre = accélère, cyan = ralentit) */
function drawSpeedPortal(po) {
  var fast = po.factor > 1, fwd = po.factor >= 1;
  var col = fast ? COL.amber : (fwd ? COL.white : COL.cyan);
  var n = po.factor >= 1.3 ? 3 : (po.factor > 1 ? 2 : 1);
  var cx = po.x + po.w / 2, y0 = po.vy, h = 234;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.shadowColor = col;
  ctx.shadowBlur = 16;
  ctx.lineWidth = 5;
  ctx.lineJoin = 'miter';
  var off = (tNow * (fast ? 2.4 : 1.1)) % 1;
  for (var k = 0; k < n; k++) {
    var ax = cx - (n - 1) * 9 + k * 18;
    ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin((k / n - off) * Math.PI));
    ctx.beginPath();
    if (fwd) { ctx.moveTo(ax - 10, y0 + 20); ctx.lineTo(ax + 10, y0 + h / 2); ctx.lineTo(ax - 10, y0 + h - 20); }
    else { ctx.moveTo(ax + 10, y0 + 20); ctx.lineTo(ax - 10, y0 + h / 2); ctx.lineTo(ax + 10, y0 + h - 20); }
    ctx.stroke();
  }
  ctx.restore();
}

/* Orbe : jaune = saut en l'air, cyan = inversion de gravité */
function drawOrb(o) {
  var col = o.kind === 'grav' ? COL.cyan : '#FFE14D';
  var pul = 1 + Math.sin(tNow * 8 + o.x) * 0.08;
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.fx > 0) {                    // onde de choc après activation
    o.fx = Math.max(0, o.fx - frameDt * 2.5);
    ctx.globalAlpha = o.fx;
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, 18 + (1 - o.fx) * 46, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = o.used ? 0.3 : 1;
  ctx.shadowColor = col;
  ctx.shadowBlur = 18;
  ctx.strokeStyle = col;
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, 0, 17 * pul, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(0, 0, 9 * pul, 0, Math.PI * 2); ctx.fill();
  if (o.kind === 'grav') {           // double flèche haut/bas
    ctx.shadowBlur = 0;
    ctx.fillStyle = COL.bg;
    ctx.beginPath(); ctx.moveTo(-5, -1); ctx.lineTo(0, -7); ctx.lineTo(5, -1); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-5, 1); ctx.lineTo(0, 7); ctx.lineTo(5, 1); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

/* Traînée de l'onde : ligne brisée néon (signature du mode) */
function drawWaveTrail() {
  if (mode !== 'wave' || p.dead || waveTrail.length < 4) return;
  ctx.save();
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = COL.pink;
  ctx.shadowColor = COL.pink;
  ctx.shadowBlur = 12;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(waveTrail[0], waveTrail[1]);
  for (var i = 2; i < waveTrail.length; i += 2) ctx.lineTo(waveTrail[i], waveTrail[i + 1]);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = COL.white;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

/* Décor du niveau 5 : trou noir qui grossit avec la progression + étoiles en distorsion */
var warpStars = [];
for (var wsi = 0; wsi < 90; wsi++) {
  warpStars.push({ x: (wsi * 173) % 1400, y: 20 + (wsi * 97) % 500, z: 0.25 + ((wsi * 37) % 100) / 110, pink: wsi % 3 === 0 });
}
function drawSingularity(pulse) {
  var prog = state === 'menu' ? 0.3 : Math.max(0, Math.min(1, p.x / cur.length));
  var cx = VW * 0.74, cy = 180, r = 16 + prog * 70 + pulse * 4;
  ctx.save();
  var g = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 2.8);
  g.addColorStop(0, 'rgba(255,77,193,0.32)');
  g.addColorStop(0.45, 'rgba(56,52,255,0.14)');
  g.addColorStop(1, 'rgba(5,5,8,0)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - r * 2.8, cy - r * 2.8, r * 5.6, r * 5.6);
  ctx.strokeStyle = 'rgba(63,211,255,0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([r * 0.45, r * 0.25]);
  ctx.lineDashOffset = -tNow * 60;
  ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.9, r * 0.42, -0.3, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,77,193,0.85)';
  ctx.lineWidth = 2 + pulse * 2.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
function drawWarp(pulse) {
  var sp = runSpeed / cur.speed;             // traînées étirées en hypervitesse
  var span = VW + 400;
  ctx.save();
  ctx.lineWidth = 2;
  for (var i = 0; i < warpStars.length; i++) {
    var s = warpStars[i];
    var sx = ((s.x - camX * s.z) % span + span) % span - 200;
    var len = 8 + s.z * 70 * sp * sp + pulse * 24 * s.z;
    ctx.strokeStyle = s.pink ? 'rgba(255,77,193,' + (0.15 + 0.3 * s.z).toFixed(2) + ')' : 'rgba(63,211,255,' + (0.12 + 0.3 * s.z).toFixed(2) + ')';
    ctx.beginPath();
    ctx.moveTo(sx, s.y);
    ctx.lineTo(sx + len, s.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPortal(po) {
  if (po.mode === 'speed') { drawSpeedPortal(po); return; }
  var isGrav = po.mode === 'grav';
  var col = isGrav ? COL.white : (po.mode === 'ship' ? COL.lime : (po.mode === 'wave' ? COL.pink : COL.blue));
  var cx = po.x + po.w / 2, cy = po.y + po.h / 2;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = 5;
  ctx.shadowColor = col;
  ctx.shadowBlur = 16;
  rrPath(po.x, po.y, po.w, po.h, 16);
  ctx.stroke();
  if (isGrav) {
    ctx.fillStyle = col;
    var up = po.dir < 0;
    for (var k = -1; k <= 1; k++) {
      var ay = cy + k * 46;
      ctx.beginPath();
      if (up) {
        ctx.moveTo(cx - 9, ay + 7);
        ctx.lineTo(cx, ay - 7);
        ctx.lineTo(cx + 9, ay + 7);
      } else {
        ctx.moveTo(cx - 9, ay - 7);
        ctx.lineTo(cx, ay + 7);
        ctx.lineTo(cx + 9, ay - 7);
      }
      ctx.closePath();
      ctx.fill();
    }
  } else if (po.mode === 'wave') {
    ctx.lineWidth = 3;
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (var z = 0; z < 6; z++) {
      var zy = cy - 60 + z * 24, zx = cx + (z % 2 ? 8 : -8);
      if (z) ctx.lineTo(zx, zy); else ctx.moveTo(zx, zy);
    }
    ctx.stroke();
  } else {
    ctx.lineWidth = 3;
    for (var i = 0; i < 3; i++) {
      var a0 = tNow * 3 + i * 2.1;
      ctx.beginPath();
      ctx.arc(cx, cy, 9 + i * 7, a0, a0 + 1.7);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawCoin(cn) {
  if (curSave().coins[cn.id]) return;
  var s = 1 + Math.sin(tNow * 6 + cn.x) * 0.12;
  ctx.save();
  ctx.translate(cn.x, cn.y);
  ctx.scale(s, s);
  ctx.shadowColor = COL.lime;
  ctx.shadowBlur = 14;
  ctx.fillStyle = COL.lime;
  ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#7A8410';
  ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawGate() {
  var gx0 = cur.gateX;
  ctx.save();
  ctx.strokeStyle = COL.lime;
  ctx.lineWidth = 5;
  ctx.shadowColor = COL.lime;
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(gx0, GY); ctx.lineTo(gx0, GY - 170);
  ctx.moveTo(gx0 + 70, GY); ctx.lineTo(gx0 + 70, GY - 170);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (var i = 0; i <= 7; i++) {
    var gx = gx0 + i * 10, gy = GY - 170 + (i % 2 === 0 ? 0 : -14);
    if (i === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
  }
  ctx.stroke();
  ctx.restore();
}

function drawCheckpoints() {
  ctx.save();
  ctx.strokeStyle = COL.lime;
  ctx.lineWidth = 3;
  ctx.shadowColor = COL.lime;
  ctx.shadowBlur = 10;
  for (var i = 0; i < cps.length; i++) {
    var c = cps[i];
    ctx.save();
    ctx.translate(c.x + 20, c.gs < 0 ? CY + 14 : GY - 14);
    ctx.rotate(Math.PI / 4);
    ctx.strokeRect(-9, -9, 18, 18);
    ctx.restore();
  }
  ctx.restore();
}

function drawPlayer() {
  if (p.dead) return;
  ctx.save();
  ctx.translate(p.x + 20, p.y + 20);
  ctx.rotate(rot);
  ctx.scale(1, gravitySign);
  if (mode === 'cube') {
    ctx.shadowColor = COL.blue;
    ctx.shadowBlur = 14;
    ctx.fillStyle = COL.white;
    ctx.fillRect(-20, -20, 40, 40);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COL.blue;
    ctx.lineWidth = 3;
    ctx.strokeRect(-19, -19, 38, 38);
    ctx.fillStyle = COL.blue;
    ctx.fillRect(-13, -9, 26, 11);
  } else if (mode === 'wave') {
    ctx.shadowColor = COL.pink;
    ctx.shadowBlur = 16;
    ctx.fillStyle = COL.white;
    ctx.beginPath();
    ctx.moveTo(15, 0); ctx.lineTo(-11, -11); ctx.lineTo(-6, 0); ctx.lineTo(-11, 11);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COL.pink;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else {
    ctx.shadowColor = COL.lime;
    ctx.shadowBlur = 14;
    ctx.fillStyle = COL.white;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(-14, -13);
    ctx.lineTo(-7, 0);
    ctx.lineTo(-14, 13);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COL.lime;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = COL.blue;
    ctx.fillRect(-2, -6, 12, 7);
  }
  ctx.restore();
}

function drawParticles() {
  for (var i = 0; i < POOL; i++) {
    var q = pool[i];
    if (!q.alive) continue;
    ctx.globalAlpha = Math.max(0, q.life / q.maxLife);
    ctx.fillStyle = q.col;
    if (q.shard) {
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(q.rot);
      ctx.beginPath();
      ctx.moveTo(0, -q.size);
      ctx.lineTo(q.size * 0.8, q.size * 0.7);
      ctx.lineTo(-q.size * 0.8, q.size * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
  }
  ctx.globalAlpha = 1;
}

function drawWorldObjects(vx0, vx1) {
  var i;
  for (i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.x > vx1 || b.x + b.w < vx0) continue;
    drawBlock(b);
  }
  for (i = 0; i < pads.length; i++) {
    if (pads[i].x > vx1 || pads[i].x + 36 < vx0) continue;
    drawPad(pads[i]);
  }
  for (i = 0; i < spikes.length; i++) {
    if (spikes[i].x > vx1 || spikes[i].x + 40 < vx0) continue;
    drawSpike(spikes[i]);
  }
  for (i = 0; i < saws.length; i++) {
    if (saws[i].x > vx1 || saws[i].x + 40 < vx0) continue;
    drawSaw(saws[i]);
  }
  for (i = 0; i < portals.length; i++) {
    if (portals[i].x > vx1 || portals[i].x + portals[i].w < vx0) continue;
    drawPortal(portals[i]);
  }
  for (i = 0; i < orbs.length; i++) {
    if (orbs[i].x > vx1 || orbs[i].x < vx0) continue;
    drawOrb(orbs[i]);
  }
  for (i = 0; i < coins.length; i++) {
    if (coins[i].x > vx1 || coins[i].x < vx0) continue;
    drawCoin(coins[i]);
  }
}

function drawHUD() {
  if (state === 'menu' || state === 'editor') return;
  var bw = 420, bx = (VW - bw) / 2, by = 14;
  var prog = Math.max(0, Math.min(1, p.x / cur.length));
  ctx.strokeStyle = COL.white;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, 12);
  ctx.fillStyle = COL.blue;
  ctx.fillRect(bx + 2, by + 2, (bw - 4) * prog, 8);
  ctx.fillStyle = COL.white;
  ctx.font = '14px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(Math.floor(prog * 100) + '%', bx + bw + 10, by + 12);
  if (Math.abs(runSpeed - cur.speed) > 1) {       // indicateur de vitesse (portails)
    ctx.fillStyle = runSpeed > cur.speed ? COL.amber : COL.cyan;
    ctx.fillText('×' + (runSpeed / cur.speed).toFixed(2).replace(/0$/, ''), bx + bw + 52, by + 12);
  }
  mpDrawHudMarkers(bx, by, bw);
  if (practice) {
    ctx.fillStyle = COL.lime;
    ctx.font = '12px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('MODE ENTRAÎNEMENT', VW / 2, by + 30);
  }
  if (testing) {
    ctx.fillStyle = COL.lime;
    ctx.font = '12px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TEST — ÉCHAP : RETOUR À L\'ÉDITEUR', VW / 2, by + 30);
  }
  var svc = curSave().coins;
  for (var i = 0; i < 3; i++) {
    var cx = VW - 90 + i * 30, cy = 20;
    ctx.strokeStyle = COL.white;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.stroke();
    if (svc[i]) {
      ctx.fillStyle = COL.lime;
      ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, VW, H);

  var pulse = audio.beatPulse();
  drawDots(pulse);
  if (cur.theme === 'warp') { drawSingularity(pulse); drawWarp(pulse); }
  drawMountains();
  drawFloatSquares();

  var sx = 0, sy = 0;
  if (shakeT > 0) {
    shakeT -= frameDt;
    var amp = 6 * Math.max(0, shakeT / 0.2);
    sx = (Math.random() * 2 - 1) * amp;
    sy = (Math.random() * 2 - 1) * amp;
  }

  ctx.save();
  ctx.translate(-camX + sx, sy);

  var vx0 = camX - 80, vx1 = camX + VW + 80;

  // Sol partout sauf dans les zones vaisseau/onde (sol et plafond y sont des blocs)
  var gx = Math.max(vx0, -200);
  var gEnd = shipZones.length ? Math.min(vx1, cur.length + 2000) : vx1;
  for (var szi = 0; szi < shipZones.length; szi++) {
    var gz = shipZones[szi], ge = Math.min(gz.x0, gEnd);
    if (ge > gx) drawGroundSeg(gx, ge);
    gx = Math.max(gx, gz.x1);
  }
  if (gx < gEnd) drawGroundSeg(gx, gEnd);

  var zi;
  for (zi = 0; zi < gravZones.length; zi++) {
    var z = gravZones[zi];
    var z0 = Math.max(vx0, z.x0), z1 = Math.min(vx1, z.x1);
    if (z0 < z1) drawCeilSeg(z0, z1);
  }
  if (cur.custom) {
    for (zi = 0; zi < autoCeilRanges.length; zi++) {
      var az = autoCeilRanges[zi];
      var az0 = Math.max(vx0, az.x0), az1 = Math.min(vx1, az.x1);
      if (az0 < az1) drawCeilSeg(az0, az1);
    }
    if (gravitySign < 0 && orbs.length && state !== 'menu') drawCeilSeg(vx0, vx1);
  }

  drawWorldObjects(vx0, vx1);
  if (hasGateObj && cur.gateX + 100 > vx0 && cur.gateX - 100 < vx1) drawGate();
  if (practice) drawCheckpoints();
  drawParticles();
  drawRemotePlayers();
  drawWaveTrail();
  drawPlayer();

  ctx.restore();
  drawHUD();
}

/* ---------------- Rendu éditeur ---------------- */
function drawEdGrid(vx0, vx1) {
  ctx.lineWidth = 1;
  var x, y;
  for (x = Math.floor(vx0 / 40) * 40; x < vx1; x += 40) {
    ctx.strokeStyle = x % 200 === 0 ? 'rgba(243,243,243,0.22)' : 'rgba(243,243,243,0.07)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (y = 80; y <= GY; y += 40) {
    ctx.strokeStyle = y % 200 === 0 ? 'rgba(243,243,243,0.16)' : 'rgba(243,243,243,0.06)';
    ctx.beginPath();
    ctx.moveTo(vx0, y);
    ctx.lineTo(vx1, y);
    ctx.stroke();
  }
  // repères de surfaces
  ctx.strokeStyle = 'rgba(198,211,45,0.35)';
  ctx.beginPath(); ctx.moveTo(vx0, GY); ctx.lineTo(vx1, GY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(vx0, CY); ctx.lineTo(vx1, CY); ctx.stroke();
}

function drawGhostObj(o, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  switch (o.t) {
    case 'spike': drawSpike({ x: o.x, y: GY, ceil: false }); break;
    case 'spikeCeil': drawSpike({ x: o.x, y: CY, ceil: true }); break;
    case 'block': drawBlock({ x: o.x, y: o.y, w: o.w, h: o.h, floor: false, ceil: false }); break;
    case 'pad': drawPad({ x: o.x, y: GY, ceil: false }); break;
    case 'padCeil': drawPad({ x: o.x, y: CY, ceil: true }); break;
    case 'saw': drawSaw({ x: o.x, y: o.y, r: 26 }); break;
    case 'portalCube': drawPortal({ mode: 'cube', dir: 0, x: o.x, y: 210, w: 34, h: 234 }); break;
    case 'portalShip': drawPortal({ mode: 'ship', dir: 0, x: o.x, y: 210, w: 34, h: 234 }); break;
    case 'portalGravUp': drawPortal({ mode: 'grav', dir: -1, x: o.x, y: 60, w: 34, h: GY - 60 }); break;
    case 'portalGravDown': drawPortal({ mode: 'grav', dir: 1, x: o.x, y: 60, w: 34, h: GY - 60 }); break;
    case 'portalWave': drawPortal({ mode: 'wave', dir: 0, x: o.x, y: 210, w: 34, h: 234 }); break;
    case 'orb': drawOrb({ x: o.x, y: o.y, kind: 'jump' }); break;
    case 'orbGrav': drawOrb({ x: o.x, y: o.y, kind: 'grav' }); break;
    case 'speedSlow': case 'speedNormal': case 'speedFast':
      drawSpeedPortal({ mode: 'speed', factor: SPEED_F[o.t], x: o.x, w: 34, vy: 210 }); break;
    case 'coin': {
      var sv = curSaveRef;
      curSaveRef = { best: 0, coins: [false, false, false] };
      drawCoin({ x: o.x, y: o.y, id: 0 });
      curSaveRef = sv;
      break;
    }
    case 'gate': {
      var g = cur.gateX;
      cur.gateX = o.x;
      drawGate();
      cur.gateX = g;
      break;
    }
  }
  ctx.restore();
}

function renderEditor() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, VW, H);
  camX = ed.cam;
  drawDots(0);

  ctx.save();
  ctx.translate(-ed.cam, 0);
  var vx0 = ed.cam - 80, vx1 = ed.cam + VW + 80;

  drawGroundSeg(vx0, vx1);
  var zi;
  for (zi = 0; zi < autoCeilRanges.length; zi++) {
    var az = autoCeilRanges[zi];
    var az0 = Math.max(vx0, az.x0), az1 = Math.min(vx1, az.x1);
    if (az0 < az1) drawCeilSeg(az0, az1);
  }

  drawWorldObjects(vx0, vx1);
  if (hasGateObj && cur.gateX + 100 > vx0 && cur.gateX - 100 < vx1) drawGate();
  drawEdGrid(vx0, vx1);

  // survol
  var m = ed.mouse;
  if (m.inside) {
    var wx = m.x + ed.cam, wy = m.y;
    if (ed.dragging && ed.tool === 'block') {
      var c0 = Math.min(ed.dragStart.cx, snapCell(wx)), c1 = Math.max(ed.dragStart.cx, snapCell(wx));
      var r0 = Math.min(ed.dragStart.cy, snapRow(wy)), r1 = Math.max(ed.dragStart.cy, snapRow(wy));
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = COL.blue;
      ctx.fillRect(c0 * 40, r0 * 40, (c1 - c0 + 1) * 40, (r1 - r0 + 1) * 40);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COL.lime;
      ctx.lineWidth = 2;
      ctx.strokeRect(c0 * 40, r0 * 40, (c1 - c0 + 1) * 40, (r1 - r0 + 1) * 40);
      ctx.restore();
    } else if (ed.dragging && (ed.tool === 'spike' || ed.tool === 'spikeCeil')) {
      var lo = Math.min(ed.dragStart.cx, snapCell(wx)), hi = Math.max(ed.dragStart.cx, snapCell(wx));
      for (var c = lo; c <= hi; c++) {
        drawGhostObj({ t: ed.tool, x: c * 40 }, 0.4);
      }
    } else if (ed.tool === 'gomme') {
      var hov = edHitAt(wx, wy);
      if (hov) {
        var hb = edObjBBox(hov);
        ctx.save();
        ctx.strokeStyle = COL.coral;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(hb.x - 2, hb.y - 2, hb.w + 4, hb.h + 4);
        ctx.restore();
      }
    } else {
      var ghost = edMakeObj(ed.tool, wx, wy);
      if (ghost) drawGhostObj(ghost, 0.4);
      var hov2 = edHitAt(wx, wy);
      if (hov2) {
        var hb2 = edObjBBox(hov2);
        ctx.save();
        ctx.strokeStyle = COL.white;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(hb2.x - 2, hb2.y - 2, hb2.w + 4, hb2.h + 4);
        ctx.restore();
      }
    }
  }

  ctx.restore();
}

/* ---------------- Entrées ---------------- */
function press() {
  audio.ensure();
  held = true;
  heldSteps = 0; relPending = false;
  orbBuf = ORB_BUF;
}
function release() {
  // Tape très brève (appui et relâche entre deux frames, fréquent au tactile) : on la garde un pas
  if (held && heldSteps === 0) { relPending = true; return; }
  held = false;
}

function evtPos(e) {
  var r = canvas.getBoundingClientRect();
  var cx = e.clientX, cy = e.clientY;
  if (cx == null && e.touches && e.touches.length) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
  if (cx == null && e.changedTouches && e.changedTouches.length) { cx = e.changedTouches[0].clientX; cy = e.changedTouches[0].clientY; }
  return { x: (cx - r.left) / viewScale, y: (cy - r.top) / viewScale };
}

window.addEventListener('keydown', function (e) {
  var tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;  // frappe dans un champ
  var k = e.code;

  if (state === 'editor') {
    if (k === 'Escape') { toMenu(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'KeyZ' && !e.shiftKey) { e.preventDefault(); edUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'KeyY' || (k === 'KeyZ' && e.shiftKey))) { e.preventDefault(); edRedo(); return; }
    if (k === 'ArrowLeft') { ed.cam = Math.max(0, ed.cam - (e.shiftKey ? 400 : 120)); $('edScroll').value = Math.round(ed.cam); edUpdatePos(); return; }
    if (k === 'ArrowRight') { ed.cam = Math.min(parseInt($('edScroll').max, 10) || 10000, ed.cam + (e.shiftKey ? 400 : 120)); $('edScroll').value = Math.round(ed.cam); edUpdatePos(); return; }
    return;
  }

  if (k === 'Space' || k === 'ArrowUp' || k === 'KeyW') {
    e.preventDefault();
    if (e.repeat) return;
    if (state === 'menu') startGame();
    else if (state === 'playing') press();
  } else if (k === 'Escape') {
    if (state === 'playing') { if (testing) backToEditor(); else pauseGame(); }
    else if (state === 'paused') resumeGame();
    else if (state === 'menu' && !elBoard.classList.contains('hidden')) {
      hideEl(elBoard);
      updateMenuStats();
      showEl(elMenu);
    }
  } else if (k === 'KeyM') {
    toggleMute();
  } else if (k === 'KeyZ') {
    if (state === 'playing' && practice) addCheckpoint();
  } else if (k === 'KeyX') {
    if (state === 'playing' && practice) removeCheckpoint();
  } else if (k === 'ArrowLeft' && state === 'menu') {
    selectLevel(selectedLevel - 1);
  } else if (k === 'ArrowRight' && state === 'menu') {
    selectLevel(selectedLevel + 1);
  }
});
window.addEventListener('keyup', function (e) {
  var k = e.code;
  if (k === 'Space' || k === 'ArrowUp' || k === 'KeyW') release();
});
window.addEventListener('blur', release);

canvas.addEventListener('mousedown', function (e) {
  if (state === 'editor') {
    e.preventDefault();
    var pos = evtPos(e);
    var wx = pos.x + ed.cam, wy = pos.y;
    ed.mouse.inside = true;
    ed.mouse.x = pos.x; ed.mouse.y = pos.y;
    if (e.button === 2) { edEraseAt(wx, wy); return; }
    if (e.button !== 0) return;
    if (e.shiftKey) { ed.panning = true; ed.panStart = { x: pos.x, cam: ed.cam }; return; }
    if (ed.tool === 'gomme') { edEraseAt(wx, wy); return; }
    if (ed.tool === 'block') { ed.dragging = true; ed.dragStart = { cx: snapCell(wx), cy: snapRow(wy) }; return; }
    if (ed.tool === 'spike' || ed.tool === 'spikeCeil') { ed.dragging = true; ed.dragStart = { cx: snapCell(wx) }; return; }
    edPlaceAt(wx, wy);
    return;
  }
  e.preventDefault();
  if (state === 'playing') press();
});
window.addEventListener('mousemove', function (e) {
  if (state !== 'editor') return;
  var pos = evtPos(e);
  ed.mouse.x = pos.x; ed.mouse.y = pos.y;
  ed.mouse.inside = pos.x >= 0 && pos.x < VW && pos.y >= 0 && pos.y < H;
  if (ed.panning) {
    ed.cam = Math.max(0, ed.panStart.cam - (pos.x - ed.panStart.x));
    var sc = $('edScroll');
    var mx = parseInt(sc.max, 10) || 10000;
    if (ed.cam > mx) ed.cam = mx;
    sc.value = Math.round(ed.cam);
    edUpdatePos();
  }
});
window.addEventListener('mouseup', function (e) {
  if (state === 'editor' && ed.dragging) {
    var pos = evtPos(e);
    var wx = pos.x + ed.cam, wy = pos.y;
    if (ed.tool === 'block') edCommitBlockDrag(wx, wy);
    else if (ed.tool === 'spike' || ed.tool === 'spikeCeil') edCommitRowDrag(wx);
    ed.dragging = false;
    ed.dragStart = null;
  }
  if (state === 'editor' && ed.panning) {
    ed.panning = false;
    ed.panStart = null;
  }
  release();
});
canvas.addEventListener('wheel', function (e) {
  if (state !== 'editor') return;
  e.preventDefault();
  var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  ed.cam = Math.max(0, ed.cam + d);
  var sc = $('edScroll');
  var mx = parseInt(sc.max, 10) || 10000;
  if (ed.cam > mx) ed.cam = mx;
  sc.value = Math.round(ed.cam);
  edUpdatePos();
}, { passive: false });
// --- Tactile ---------------------------------------------------------------
// Édition : 1 doigt = poser / dimensionner (bloc, pic) / gommer, comme le clic
// gauche. 2 doigts = déplacer la vue (sinon le curseur du bas fait défiler).
canvas.addEventListener('touchstart', function (e) {
  if (state === 'editor') {
    e.preventDefault();
    if (e.touches.length >= 2) {
      ed.dragging = false; ed.dragStart = null;
      ed.panning = true; ed.panStart = { x: evtPos(e).x, cam: ed.cam };
      return;
    }
    var pos = evtPos(e);
    var wx = pos.x + ed.cam, wy = pos.y;
    ed.mouse.inside = true; ed.mouse.x = pos.x; ed.mouse.y = pos.y;
    if (ed.tool === 'gomme') { edEraseAt(wx, wy); return; }
    if (ed.tool === 'block') { ed.dragging = true; ed.dragStart = { cx: snapCell(wx), cy: snapRow(wy) }; return; }
    if (ed.tool === 'spike' || ed.tool === 'spikeCeil') { ed.dragging = true; ed.dragStart = { cx: snapCell(wx) }; return; }
    edPlaceAt(wx, wy);
    return;
  }
  e.preventDefault();
  if (state === 'playing') press();
}, { passive: false });
canvas.addEventListener('touchmove', function (e) {
  if (state !== 'editor') return;
  e.preventDefault();
  var pos = evtPos(e);
  ed.mouse.x = pos.x; ed.mouse.y = pos.y;
  ed.mouse.inside = pos.x >= 0 && pos.x < VW && pos.y >= 0 && pos.y < H;
  if (ed.panning && ed.panStart) {
    ed.cam = Math.max(0, ed.panStart.cam - (pos.x - ed.panStart.x));
    var sc = $('edScroll');
    var mx = parseInt(sc.max, 10) || 10000;
    if (ed.cam > mx) ed.cam = mx;
    sc.value = Math.round(ed.cam);
    edUpdatePos();
  }
}, { passive: false });
canvas.addEventListener('touchend', function (e) {
  if (state === 'editor') {
    e.preventDefault();
    if (ed.dragging) {
      var pos = evtPos(e);
      var wx = pos.x + ed.cam, wy = pos.y;
      if (ed.tool === 'block') edCommitBlockDrag(wx, wy);
      else if (ed.tool === 'spike' || ed.tool === 'spikeCeil') edCommitRowDrag(wx);
      ed.dragging = false; ed.dragStart = null;
    }
    if (ed.panning && (!e.touches || e.touches.length === 0)) { ed.panning = false; ed.panStart = null; }
    return;
  }
  e.preventDefault();
  if (e.touches && e.touches.length > 0) return;   // un autre doigt reste posé : l'appui continue
  release();
}, { passive: false });
canvas.addEventListener('touchcancel', function (e) {
  if (state === 'editor') return;
  if (e.touches && e.touches.length > 0) return;
  release();
});
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

/* ---------------- Boutons ---------------- */
function wireBtn(id, fn) {
  $(id).addEventListener('click', function (e) {
    fn(e);
    if (e.currentTarget && e.currentTarget.blur) e.currentTarget.blur();
  });
}
wireBtn('btnPlay', startGame);
wireBtn('btnEditor', function () { editorNew(); enterEditor(); });
wireBtn('btnPublic', openPublicPanel);
wireBtn('btnTrophies', function () { renderTrophies(); showEl(elTrophies); });
wireBtn('trophClose', function () { hideEl(elTrophies); });

/* Plein écran — déclenché UNIQUEMENT par un geste utilisateur (clic) */
function fsUpdateIcon() {
  elBtnFull.classList.toggle('fs-on', !!document.fullscreenElement);
}
wireBtn('btnFull', function () {
  if (document.fullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
  } else {
    var de = document.documentElement;
    if (de && de.requestFullscreen) {
      try {
        var r = de.requestFullscreen();
        if (r && r.catch) r.catch(function () { /* refusé par le navigateur */ });
      } catch (e) { /* plein écran indisponible */ }
    }
  }
});
document.addEventListener('fullscreenchange', fsUpdateIcon);
/* Bouton plein écran visible seulement sur tactile */
if (isTouchDevice()) document.body.classList.add('is-touch');
wireBtn('btnPause', function () { if (!testing) pauseGame(); });
wireBtn('btnEdit', backToEditor);
wireBtn('btnResume', resumeGame);
wireBtn('btnRestart', function () {
  hideEl(elPause);
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  respawn();
});
wireBtn('btnMenu', toMenu);
wireBtn('btnSound', toggleMute);
wireBtn('btnAgain', startGame);
wireBtn('btnMenu2', toMenu);

wireBtn('edMenu', toMenu);
wireBtn('edTest', editorTest);
wireBtn('edSave', editorSave);
wireBtn('edMine', function () { renderMyLevels(); showEl(elMyLevels); });
wireBtn('edUndo', edUndo);
wireBtn('edRedo', edRedo);
wireBtn('mlClose', function () { hideEl(elMyLevels); });
wireBtn('mlPublic', openPublicPanel);
wireBtn('plClose', function () { hideEl(elPublic); });
wireBtn('plRefresh', function () { if (mp.open) mpSend({ t: 'listLevels' }); renderPublicList(); });
wireBtn('mlResetDemo', function () {
  store.demoDeleted = false;
  seedDemo();
  save();
  rebuildMenuCards();
  renderMyLevels();
  edMsg('NIVEAU DÉMO réinitialisé ✔');
});
wireBtn('mlImport', function () {
  $('importText').value = '';
  $('importErr').textContent = '';
  hideEl(elMyLevels);
  showEl(elImportModal);
});
wireBtn('importCancel', function () { hideEl(elImportModal); });
wireBtn('importOk', function () {
  var r = importJSON($('importText').value);
  if (r.ok) {
    hideEl(elImportModal);
    edMsg('Niveau importé ✔ (' + r.rec.objects.length + ' objets)');
  } else {
    $('importErr').textContent = r.err;
  }
});
wireBtn('exportClose', function () { hideEl(elExportModal); });
wireBtn('exportCopy', function () {
  copyText($('exportText').value);
  edMsg('JSON copié dans le presse-papiers ✔');
});

$('edScroll').addEventListener('input', function () {
  ed.cam = parseInt($('edScroll').value, 10) || 0;
  edUpdatePos();
});
$('edName').addEventListener('input', function () {});
$('edSpeed').addEventListener('input', function () { updateSpeedLabel(); edRebuild(); });
$('edBpm').addEventListener('change', edRebuild);

/* ---------------- API console / tests ---------------- */
window.NEONDASH = {
  state: function () { return state; },
  store: function () { return store; },
  levelList: levelList,
  ed: {
    reset: editorNew,
    setMeta: function (name, speed, bpm) {
      $('edName').value = name;
      $('edSpeed').value = String(speed);
      $('edBpm').value = String(bpm);
      edRebuild();
    },
    add: function (t, x, y, w, h) {
      var o = { t: t, x: x, y: y };
      if (t === 'block') { o.w = w || 40; o.h = h || 40; }
      ed.objects.push(o);
      edPushUndo({ add: [o], del: [] });
      edRebuild();
      return o;
    },
    objects: function () { return ed.objects; },
    test: editorTest,
    back: backToEditor,
    save: editorSave,
    load: loadCustomIntoEditor,
    undo: edUndo,
    redo: edRedo
  },
  custom: function () { return store.custom; },
  exportJSON: exportJSON,
  importJSON: importJSON,
  checkTrophies: checkTrophies,
  TROPHIES: TROPHIES,
  fit: fit
};

/* ============================================================
   MULTIJOUEUR — WebSocket vers le serveur (/ws)
   Fantômes des autres joueurs (pseudo au-dessus, style Roblox),
   compteur en ligne, classement mondial persisté côté serveur.
   ============================================================ */
var MP_COLORS = ['#FF624D', '#C6D32D', '#3FD3FF', '#FF4DC1', '#7CFF6B', '#FFB13D', '#9D6BFF', '#F3F3F3'];
var MP_SEND_MS = 66;            // ~15 états/s
var MP_STALE_MS = 5000;         // fantôme masqué sans nouvelles

var mp = {
  ws: null, open: false, id: 0, color: 0,
  players: {},                  // id -> joueur distant
  scores: {},                   // levelKey -> { name, entries[] }
  count: 0,
  lastSend: 0,
  wasInLevel: false,
  retry: 2000, retryTimer: null,
  pubList: [],                  // catalogue public (métadonnées) reçu du serveur
  pendingPlay: false            // action en attente après getLevel (true = jouer, false = récupérer)
};

function mpSanitize(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9 _\-]/g, '').trim().slice(0, 14);
}

function mpPseudo() {
  if (!store.pseudo) {
    store.pseudo = 'JOUEUR-' + Math.floor(1000 + Math.random() * 9000);
    save();
  }
  return store.pseudo;
}

/* Clé de classement/fantômes : officiels et démo par id ;
   customs par nom (deux joueurs qui partagent un niveau partagent son tableau). */
function mpLevelKey(lvl) {
  var l = lvl || cur;
  if (!l) return null;
  if (!l.custom || l.id === 'demo') return l.id;
  return 'c:' + l.name;
}

function mpSend(obj) {
  if (!mp.open) return;
  try { mp.ws.send(JSON.stringify(obj)); } catch (e) { /* connexion perdue */ }
}

function mpConnect() {
  if (mp.ws || !window.WebSocket) return;
  var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  var ws;
  try { ws = new WebSocket(url); } catch (e) { mpRetry(); return; }
  mp.ws = ws;

  ws.onopen = function () {
    mp.open = true;
    mp.retry = 2000;
    mpSend({ t: 'hello', name: mpPseudo() });
  };
  ws.onmessage = function (ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome':
        mp.id = m.id;
        mp.color = m.color || 0;
        mp.players = {};
        (m.players || []).forEach(function (o) { mpUpsert(o); });
        if (m.scores && typeof m.scores === 'object') mp.scores = m.scores;
        mp.count = m.n || 1;
        break;
      case 'join':
        if (m.p) mpUpsert(m.p);
        break;
      case 'quit':
        delete mp.players[m.id];
        break;
      case 'count':
        mp.count = m.n || 0;
        break;
      case 'state': {
        var rp = mp.players[m.id];
        if (!rp) { rp = mpUpsert({ id: m.id, name: '???', color: m.id % MP_COLORS.length }); }
        rp.lvl = m.lvl || null;
        if (rp.lvl) {
          if (rp.rx === null || Math.abs(m.x - rp.x) > 900) { rp.rx = m.x; rp.ry = m.y; }
          rp.x = m.x; rp.y = m.y;
          rp.m = m.m; rp.g = m.g; rp.r = m.r || 0;
          rp.d = !!m.d; rp.pr = m.pr || 0;
        } else {
          rp.rx = null; rp.d = true;
        }
        rp.seen = performance.now();
        break;
      }
      case 'scores':
        if (m.lvl && m.board) mp.scores[m.lvl] = m.board;
        if (!elBoard.classList.contains('hidden')) renderBoard();
        break;
      case 'published':
        panelMsg('mlMsg', m.ok
          ? (m.updated ? 'Niveau mis à jour ✔ (déjà publié)' : 'Niveau publié ✔ — visible dans NIVEAUX PUBLICS')
          : ('Publication refusée : ' + (m.err || 'erreur')));
        break;
      case 'levelList':
        mp.pubList = Array.isArray(m.levels) ? m.levels : [];
        if (!elPublic.classList.contains('hidden')) renderPublicList();
        break;
      case 'levelData':
        if (m.level) receivePublicLevel(m.level, mp.pendingPlay);
        else panelMsg('plMsg', 'Niveau indisponible : ' + (m.err || 'introuvable'));
        break;
    }
    mpUpdateMenuUI();
  };
  ws.onclose = function () { mpDown(); };
  ws.onerror = function () { try { ws.close(); } catch (e) { /* déjà fermé */ } };
}

/* ---------------- Catalogue de niveaux publics ---------------- */
var panelMsgTimers = {};
function panelMsg(id, text) {
  var el = $(id);
  if (!el) return;
  el.textContent = text;
  if (panelMsgTimers[id]) clearTimeout(panelMsgTimers[id]);
  panelMsgTimers[id] = setTimeout(function () { el.textContent = ''; }, 3500);
}

function publishLevel(rec) {
  if (!mp.open) { panelMsg('mlMsg', 'Hors ligne — connexion au serveur requise pour publier.'); return; }
  if (!rec || !rec.objects || !rec.objects.length) { panelMsg('mlMsg', 'Niveau vide — rien à publier.'); return; }
  mpSend({ t: 'pubLevel', name: rec.name, speed: rec.speed, bpm: rec.bpm, objects: rec.objects });
  panelMsg('mlMsg', 'Publication de « ' + rec.name + ' » en cours…');
}

function openPublicPanel() {
  hideEl(elMyLevels);
  showEl(elPublic);
  if (mp.open) {
    mpSend({ t: 'listLevels' });
    $('plList').innerHTML = '<div class="ml-empty">Chargement du catalogue…</div>';
  } else {
    renderPublicList();
  }
}

function renderPublicList() {
  var box = $('plList');
  box.innerHTML = '';
  if (!mp.open) {
    var off = document.createElement('div');
    off.className = 'ml-empty';
    off.textContent = 'Hors ligne — impossible de charger le catalogue.';
    box.appendChild(off);
    return;
  }
  if (!mp.pubList.length) {
    var empty = document.createElement('div');
    empty.className = 'ml-empty';
    empty.textContent = 'Aucun niveau public pour le moment — publie le tien depuis MES NIVEAUX !';
    box.appendChild(empty);
    return;
  }
  mp.pubList.forEach(function (lv) {
    var row = document.createElement('div');
    row.className = 'ml-row';
    var info = document.createElement('div');
    info.className = 'ml-info';
    info.innerHTML = '<b>' + escapeHTML(lv.name) + '</b><span>par ' + escapeHTML(lv.author) +
      ' · ' + lv.count + ' objets · ' + lv.speed + ' px/s · ' + (lv.plays || 0) + ' parties</span>';
    row.appendChild(info);
    function mkBtn(label, fn) {
      var b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = label;
      b.addEventListener('click', fn);
      row.appendChild(b);
    }
    mkBtn('JOUER', function () { requestPublic(lv.id, true); });
    mkBtn('RÉCUPÉRER', function () { requestPublic(lv.id, false); });
    box.appendChild(row);
  });
}

function requestPublic(id, play) {
  if (!mp.open) { panelMsg('plMsg', 'Hors ligne — catalogue indisponible.'); return; }
  mp.pendingPlay = !!play;
  if (!play) panelMsg('plMsg', 'Récupération…');
  mpSend({ t: 'getLevel', id: id });
}

// Reçoit un niveau public complet : réutilise un custom du même nom s'il existe, sinon l'importe.
function receivePublicLevel(level, play) {
  var rec = null;
  for (var i = 0; i < store.custom.length; i++) {
    if (store.custom[i].name === level.name) { rec = store.custom[i]; break; }
  }
  if (!rec) {
    var r = importJSON(JSON.stringify({ v: 1, name: level.name, speed: level.speed, bpm: level.bpm, objects: level.objects }));
    if (!r.ok) { panelMsg('plMsg', 'Niveau public invalide : ' + r.err); return; }
    rec = r.rec;
  }
  if (play) {
    var idx = levelList().findIndex(function (l) { return l.id === rec.id; });
    if (idx >= 0) { selectedLevel = idx; hideEl(elPublic); hideEl(elMyLevels); startGame(); }
  } else {
    panelMsg('plMsg', '« ' + rec.name + ' » récupéré dans MES NIVEAUX ✔');
  }
}

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function mpDown() {
  mp.ws = null;
  mp.open = false;
  mp.players = {};
  mp.count = 0;
  mpUpdateMenuUI();
  mpRetry();
}

function mpRetry() {
  if (mp.retryTimer) return;
  mp.retryTimer = setTimeout(function () {
    mp.retryTimer = null;
    mp.retry = Math.min(15000, mp.retry * 1.6);
    mpConnect();
  }, mp.retry);
}

function mpUpsert(o) {
  var rp = mp.players[o.id];
  if (!rp) {
    rp = mp.players[o.id] = {
      id: o.id, name: '', color: 0,
      lvl: null, lvlName: '',
      x: 0, y: 0, m: 'cube', g: 1, r: 0, d: false, pr: 0,
      rx: null, ry: 0, seen: 0
    };
  }
  if (typeof o.name === 'string' && o.name) rp.name = o.name;
  if (typeof o.color === 'number') rp.color = o.color % MP_COLORS.length;
  if ('lvl' in o) rp.lvl = o.lvl;
  if ('lvlName' in o) rp.lvlName = o.lvlName || '';
  return rp;
}

/* --- Envoi de l'état local (~15 Hz pendant le jeu, hors test éditeur) --- */
function mpTick(now) {
  if (!mp.open) return;
  var inLevel = !testing &&
    (state === 'playing' || state === 'dead' || state === 'paused' || state === 'win');
  if (!inLevel) {
    if (mp.wasInLevel) { mpSend({ t: 'leave' }); mp.wasInLevel = false; }
    return;
  }
  mp.wasInLevel = true;
  if (now - mp.lastSend < MP_SEND_MS) return;
  mp.lastSend = now;
  mpSend({
    t: 'state',
    lvl: mpLevelKey(), lvlName: cur.name,
    x: Math.round(p.x), y: Math.round(p.y),
    m: mode, g: gravitySign, r: Math.round(rot * 100) / 100,
    d: state === 'dead',
    pr: Math.min(100, Math.floor(p.x / cur.length * 100))
  });
}

function mpSubmitScore(pct, time) {
  if (!mp.open || practice || testing) return;
  var sv = curSave(), nc = 0;
  for (var i = 0; i < 3; i++) if (sv.coins[i]) nc++;
  mpSend({
    t: 'score',
    lvl: mpLevelKey(), lvlName: cur.name,
    pct: pct, time: time, coins: nc
  });
}

/* --- Rendu des fantômes (dans le repère monde, avant le joueur local) --- */
function drawRemotePlayers() {
  if (state === 'menu' || state === 'editor') return;
  var key = mpLevelKey();
  if (!key) return;
  var now = performance.now();
  for (var id in mp.players) {
    var rp = mp.players[id];
    if (rp.lvl !== key || rp.d || rp.rx === null) continue;
    if (now - rp.seen > MP_STALE_MS) continue;

    // Interpolation : avance à la vitesse du niveau, converge vers le dernier état reçu.
    var gsp = speedAt(rp.x);
    if (rp.rx - rp.x < gsp * 0.15) rp.rx += gsp * frameDt;
    rp.rx += (rp.x - rp.rx) * Math.min(1, frameDt * 4);
    rp.ry += (rp.y - rp.ry) * Math.min(1, frameDt * 14);

    if (rp.rx < camX - 120 || rp.rx > camX + VW + 120) continue;
    drawGhostPlayer(rp);
  }
}

function drawGhostPlayer(rp) {
  var col = MP_COLORS[rp.color] || COL.white;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.translate(rp.rx + 20, rp.ry + 20);
  ctx.rotate(rp.r);
  ctx.scale(1, rp.g);
  ctx.shadowColor = col;
  ctx.shadowBlur = 10;
  if (rp.m === 'wave') {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(15, 0); ctx.lineTo(-11, -11); ctx.lineTo(-6, 0); ctx.lineTo(-11, 11);
    ctx.closePath();
    ctx.fill();
  } else if (rp.m === 'ship') {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(20, 0);
    ctx.lineTo(-14, -13);
    ctx.lineTo(-7, 0);
    ctx.lineTo(-14, 13);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COL.white;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.fillStyle = col;
    ctx.fillRect(-20, -20, 40, 40);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COL.white;
    ctx.lineWidth = 2;
    ctx.strokeRect(-19, -19, 38, 38);
    ctx.fillStyle = 'rgba(5,5,8,0.55)';
    ctx.fillRect(-13, -9, 26, 11);
  }
  ctx.restore();

  // Étiquette pseudo (toujours au-dessus, non retournée par la gravité)
  var name = rp.name || '???';
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.font = '12px Impact, "Arial Black", sans-serif';
  var tw = ctx.measureText(name).width;
  var tx = rp.rx + 20, ty = rp.ry - 16;
  ctx.fillStyle = 'rgba(5,5,8,0.72)';
  ctx.fillRect(tx - tw / 2 - 7, ty - 12, tw + 14, 17);
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tx - tw / 2 - 7, ty - 12, tw + 14, 17);
  ctx.beginPath();
  ctx.moveTo(tx - 4, ty + 5);
  ctx.lineTo(tx + 4, ty + 5);
  ctx.lineTo(tx, ty + 10);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = COL.white;
  ctx.fillText(name, tx, ty + 1);
  ctx.restore();
}

/* --- Marqueurs des autres joueurs sur la barre de progression --- */
function mpDrawHudMarkers(bx, by, bw) {
  var key = mpLevelKey();
  if (!key) return;
  var now = performance.now();
  for (var id in mp.players) {
    var rp = mp.players[id];
    if (rp.lvl !== key || now - rp.seen > MP_STALE_MS) continue;
    var mx = bx + 2 + (bw - 4) * Math.max(0, Math.min(1, rp.pr / 100));
    var col = MP_COLORS[rp.color] || COL.white;
    ctx.fillStyle = col;
    ctx.globalAlpha = rp.d ? 0.35 : 1;
    ctx.beginPath();
    ctx.moveTo(mx - 5, by - 3);
    ctx.lineTo(mx + 5, by - 3);
    ctx.lineTo(mx, by + 4);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/* --- UI menu : statut + compteur --- */
var elBoard = $('board');
function mpUpdateMenuUI() {
  var st = $('mpStatus'), txt = $('mpStatusTxt');
  if (mp.open) {
    st.classList.add('on'); st.classList.remove('off');
    txt.textContent = 'EN LIGNE · ' + mp.count + ' JOUEUR' + (mp.count > 1 ? 'S' : '');
  } else {
    st.classList.add('off'); st.classList.remove('on');
    txt.textContent = 'HORS LIGNE';
  }
  if (!elBoard.classList.contains('hidden')) renderBoard();
}

/* --- Panneau CLASSEMENT --- */
var boardIdx = 0;
function fmtBoardTime(t) {
  return (typeof t === 'number' && isFinite(t)) ? t.toFixed(1) + ' s' : '—';
}
function renderBoard() {
  var list = levelList();
  boardIdx = Math.max(0, Math.min(list.length - 1, boardIdx));
  var lvl = list[boardIdx];
  $('bdLevel').textContent = lvl.name + ' — ' + lvl.sub;
  var key = mpLevelKey(lvl);
  var board = mp.scores[key];
  var box = $('bdList');
  box.innerHTML = '';
  if (!mp.open && !board) {
    box.innerHTML = '<div class="bd-empty">HORS LIGNE — CLASSEMENT INDISPONIBLE</div>';
  } else if (!board || !board.entries || !board.entries.length) {
    box.innerHTML = '<div class="bd-empty">AUCUN SCORE — SOIS LE PREMIER !</div>';
  } else {
    board.entries.slice(0, 10).forEach(function (e, i) {
      var row = document.createElement('div');
      row.className = 'bd-row' + (e.name === mpPseudo() ? ' me' : '');
      var rk = i === 0 ? 'r1' : (i === 1 ? 'r2' : (i === 2 ? 'r3' : ''));
      row.innerHTML =
        '<span class="bd-rank ' + rk + '">' + (i + 1) + '</span>' +
        '<span class="bd-name"></span>' +
        '<span class="bd-pct">' + e.pct + '%</span>' +
        '<span class="bd-time">' + fmtBoardTime(e.time) + '</span>' +
        '<span class="bd-coins">' + '●'.repeat(e.coins || 0) + '○'.repeat(3 - (e.coins || 0)) + '</span>';
      row.querySelector('.bd-name').textContent = e.name;
      box.appendChild(row);
    });
  }
  // Joueurs en ligne
  $('bdCount').textContent = mp.count;
  var ob = $('bdOnline');
  ob.innerHTML = '';
  if (!mp.open) {
    ob.innerHTML = '<div class="bd-empty">CONNEXION AU SERVEUR…</div>';
  } else {
    var meRow = document.createElement('div');
    meRow.className = 'bd-on-row me';
    meRow.innerHTML = '<span class="bd-dot" style="background:' + (MP_COLORS[mp.color] || '#fff') + '"></span>' +
      '<span class="bd-name"></span><span class="bd-on-lvl">TOI — AU MENU</span>';
    meRow.querySelector('.bd-name').textContent = mpPseudo();
    ob.appendChild(meRow);
    var now = performance.now();
    for (var id in mp.players) {
      var rp = mp.players[id];
      var row2 = document.createElement('div');
      row2.className = 'bd-on-row';
      var playing = rp.lvl && now - rp.seen < MP_STALE_MS && !rp.d ? 'JOUE : ' + (rp.lvlName || rp.lvl) : 'AU MENU';
      row2.innerHTML = '<span class="bd-dot" style="background:' + (MP_COLORS[rp.color] || '#fff') + '"></span>' +
        '<span class="bd-name"></span><span class="bd-on-lvl"></span>';
      row2.querySelector('.bd-name').textContent = rp.name || '???';
      row2.querySelector('.bd-on-lvl').textContent = playing;
      ob.appendChild(row2);
    }
  }
}

/* --- Rang mondial affiché sur l'écran de victoire --- */
function mpWinRankText() {
  var key = mpLevelKey();
  var board = mp.scores[key];
  if (!board || !board.entries) return '';
  for (var i = 0; i < board.entries.length; i++) {
    if (board.entries[i].name === mpPseudo()) return 'CLASSEMENT MONDIAL : #' + (i + 1);
  }
  return '';
}

/* --- Câblage UI multijoueur --- */
(function mpWireUI() {
  var inp = $('mpName');
  inp.value = mpPseudo();
  function commitName() {
    var n = mpSanitize(inp.value);
    if (!n) { inp.value = store.pseudo; return; }
    inp.value = n;
    if (n === store.pseudo) return;
    store.pseudo = n;
    save();
    mpSend({ t: 'name', name: n });
  }
  inp.addEventListener('change', commitName);
  inp.addEventListener('keydown', function (e) {
    e.stopPropagation();               // ne pas déclencher le saut / les raccourcis
    if (e.key === 'Enter') inp.blur();
  });
  inp.addEventListener('keyup', function (e) { e.stopPropagation(); });

  $('btnBoard').addEventListener('click', function () {
    boardIdx = selectedLevel;
    renderBoard();
    hideEl(elMenu);
    showEl(elBoard);
  });
  $('bdClose').addEventListener('click', function () {
    hideEl(elBoard);
    updateMenuStats();
    showEl(elMenu);
  });
  $('bdPrev').addEventListener('click', function () { boardIdx--; renderBoard(); });
  $('bdNext').addEventListener('click', function () { boardIdx++; renderBoard(); });
})();

mpConnect();

/* ---------------- Boucle principale ---------------- */
var last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  var dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  frameDt = dt;
  tNow = now / 1000;

  if (state === 'playing' || state === 'dead') {
    acc += dt;
    var n = 0;
    while (acc >= STEP && n < 40) {
      if (state === 'playing') stepGame(STEP);
      else stepDead(STEP);
      acc -= STEP;
      n++;
      if (state !== 'playing' && state !== 'dead') { acc = 0; break; }
    }
    if (n === 40) acc = 0;
  }
  updateParticles(dt);
  if (state === 'win') {
    winT += dt;
    if (testing) {
      if (winT > 1.4) backToEditor();
    } else if (winT > 0.7) {
      showWinOnce();
    }
  }
  if (state === 'playing' && cur.music && cur.music.octMid) {
    var pr = p.x / cur.length;
    audio.octUp = pr > 1 / 3 && pr < 2 / 3;
  } else {
    audio.octUp = false;
  }
  mpTick(now);
  if (state === 'editor') renderEditor();
  else render();
  drawToast(dt);
  elBtnPause.classList.toggle('hidden', state !== 'playing' || testing);
  elBtnEdit.classList.toggle('hidden', !(state === 'playing' && testing));
}

edBuildToolbar();
editorNew();
loadLevel(0);
updateMenuStats();
updateSoundLabel();
requestAnimationFrame(frame);

})();
