require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();

// ==== TOKEN DE L'EMETTEUR ====
// Doit etre defini dans le fichier .env (jamais commit sur GitHub)
const BROADCASTER_TOKEN = process.env.BROADCASTER_TOKEN;
if (!BROADCASTER_TOKEN) {
  console.error('ERREUR : BROADCASTER_TOKEN n\'est pas defini dans le fichier .env');
  console.error('Copie .env.example en .env et renseigne un token avant de lancer le serveur.');
  process.exit(1);
}

// Comparaison en temps constant pour eviter les attaques par timing
function tokenMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(BROADCASTER_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ==== PERSISTANCE DES NOTES (fichier local, survit aux redemarrages) ====
const NOTES_FILE = path.join(__dirname, 'viewer-notes.json');

function loadNotes() {
  try {
    const raw = fs.readFileSync(NOTES_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (err) {
    // Fichier absent ou invalide au premier lancement : on part d'une Map vide
    return new Map();
  }
}

function saveNotes(notesMap) {
  const obj = Object.fromEntries(notesMap);
  fs.writeFile(NOTES_FILE, JSON.stringify(obj, null, 2), (err) => {
    if (err) console.error('Erreur de sauvegarde des notes :', err);
  });
}
const server = http.createServer(app);

// ==== ORIGINES AUTORISEES POUR LE WEBSOCKET ====
// Empeche un site tiers d'ouvrir une connexion WebSocket vers ce serveur
// depuis le navigateur d'un visiteur (Cross-Site WebSocket Hijacking).
function buildAllowedOrigins() {
  const origins = new Set([`http://localhost:${process.env.PORT || 3000}`]);
  if (process.env.NGROK_DOMAIN) {
    origins.add(`https://${process.env.NGROK_DOMAIN}`);
  }
  return origins;
}
const ALLOWED_ORIGINS = buildAllowedOrigins();

const wss = new WebSocketServer({
  server,
  verifyClient: (info, callback) => {
    const origin = info.origin || info.req.headers.origin;
    // Pas d'en-tete Origin (client non-navigateur, ex: outil de test) : on laisse passer,
    // le reste (token, roles) protege deja les actions sensibles.
    if (!origin) return callback(true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(true);
    console.warn(`[SECURITE] Connexion WebSocket refusee, origine non autorisee : ${origin}`);
    callback(false, 403, 'Origine non autorisee');
  }
});

// Rate limit general : evite le flood de requetes HTTP (scan, brute-force du token, etc.)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(generalLimiter);

// En-tetes de securite : empeche l'affichage du site dans un <iframe> tiers (clickjacking)
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/sender', (req, res) => {
  const ip = getRealIp(req);
  if (isLockedOut(ip)) {
    console.warn(`[SECURITE] Acces a /sender refuse (IP bloquee) : ${ip}`);
    return res.status(429).send('Trop de tentatives. Reessaie plus tard.');
  }
  // Sans le bon token, on ne sert meme pas la page (pas de fuite d'info)
  if (!tokenMatches(req.query.token)) {
    recordFailedAttempt(ip);
    console.warn(`[SECURITE] Tentative d'acces a /sender refusee depuis ${ip}`);
    return res.status(403).send('Acces refuse.');
  }
  clearFailedAttempts(ip);
  res.sendFile(path.join(__dirname, 'public', 'sender.html'));
});

// Page spectateur : le lien "prive" a partager
// Le viewerId permet d'avoir un lien difficile a deviner
app.get('/watch/:room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/', (req, res) => {
  res.send('Serveur de partage d\'ecran actif.');
});

// ==== SIGNALISATION WEBSOCKET ====
// Un seul "room" simple pour commencer : tout le monde qui rejoint est spectateur,
// sauf celui qui s'annonce comme "broadcaster" avec le bon token.

let broadcaster = null; // connexion ws de l'emetteur
const viewers = new Map(); // viewerId -> ws
const viewerNotes = loadNotes(); // ip -> note (charge depuis viewer-notes.json, persiste entre les redemarrages)
const MAX_VIEWERS = parseInt(process.env.MAX_VIEWERS, 10) || 10;

function send(ws, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Extrait l'IP reelle du client de facon fiable.
// ngrok tourne en local et ajoute TOUJOURS sa propre entree en dernier dans
// X-Forwarded-For. Si un attaquant falsifie cet en-tete, sa fausse valeur
// se retrouve en premiere position, pas en derniere : on prend donc la
// DERNIERE entree ajoutee par le proxy de confiance, jamais la premiere.
// On ne fait confiance a l'en-tete que si la connexion vient bien de la
// machine locale (c'est le cas quand ngrok tourne sur le meme PC).
function getRealIp(req) {
  const socketIp = req.socket.remoteAddress;
  const isFromLocalProxy = socketIp === '127.0.0.1' || socketIp === '::1' || socketIp === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  if (isFromLocalProxy && forwarded) {
    const parts = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || socketIp;
  }
  return socketIp;
}

// Rate limit WebSocket : max N messages par fenetre de temps par connexion
const WS_RATE_LIMIT = 30; // messages
const WS_RATE_WINDOW_MS = 10 * 1000; // 10 secondes

// ==== ANTI-BRUTEFORCE DU TOKEN (par IP, persiste entre les connexions) ====
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const failedAttempts = new Map(); // ip -> { count, lockedUntil }

function isLockedOut(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    failedAttempts.delete(ip); // le blocage a expire, on repart a zero
    return false;
  }
  return false;
}

function recordFailedAttempt(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count++;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    console.warn(`[SECURITE] IP ${ip} bloquee ${LOCKOUT_MS / 60000} min apres ${entry.count} echecs de token`);
  }
  failedAttempts.set(ip, entry);
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

// Nettoyage periodique : evite que ces Maps grossissent indefiniment sur un serveur
// qui tourne longtemps (les entrees expirees ou les IP sans connexion active sont purgees)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedAttempts) {
    if (entry.lockedUntil && now >= entry.lockedUntil) failedAttempts.delete(ip);
  }
  for (const [ip, count] of connectionsPerIp) {
    if (count <= 0) connectionsPerIp.delete(ip);
  }
}, 5 * 60 * 1000); // toutes les 5 minutes

// ==== LIMITE DE CONNEXIONS WEBSOCKET BRUTES PAR IP (avant meme viewer-join) ====
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 8;
const connectionsPerIp = new Map(); // ip -> nombre de connexions actives

wss.on('connection', (ws, req) => {
  ws.id = crypto.randomUUID();
  ws.ip = getRealIp(req);

  // Limite de connexions simultanees par IP, avant meme tout message
  const currentCount = connectionsPerIp.get(ws.ip) || 0;
  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    console.warn(`[SECURITE] Trop de connexions simultanees depuis ${ws.ip}, connexion refusee`);
    ws.close();
    return;
  }
  connectionsPerIp.set(ws.ip, currentCount + 1);

  ws.msgCount = 0;
  ws.msgWindowStart = Date.now();

  ws.on('message', (raw) => {
    // Anti-flood : trop de messages dans la fenetre -> on ignore et on coupe si ca persiste
    const now = Date.now();
    if (now - ws.msgWindowStart > WS_RATE_WINDOW_MS) {
      ws.msgWindowStart = now;
      ws.msgCount = 0;
    }
    ws.msgCount++;
    if (ws.msgCount > WS_RATE_LIMIT) {
      if (ws.msgCount > WS_RATE_LIMIT * 3) ws.close(); // flood persistant -> deconnexion
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'broadcaster-join': {
        if (isLockedOut(ws.ip)) {
          console.warn(`[SECURITE] Tentative de connexion broadcaster refusee (IP bloquee) : ${ws.ip}`);
          send(ws, { type: 'auth-error', message: 'Trop de tentatives. Reessaie plus tard.' });
          ws.close();
          return;
        }
        if (!tokenMatches(msg.token)) {
          recordFailedAttempt(ws.ip);
          console.warn(`[SECURITE] Token invalide sur broadcaster-join depuis ${ws.ip}`);
          send(ws, { type: 'auth-error', message: 'Token invalide.' });
          ws.close();
          return;
        }
        clearFailedAttempts(ws.ip);
        if (broadcaster && broadcaster.readyState === broadcaster.OPEN) {
          // Un emetteur est deja connecte : on refuse le second pour eviter les conflits
          send(ws, { type: 'auth-error', message: 'Un emetteur est deja connecte.' });
          ws.close();
          return;
        }
        broadcaster = ws;
        ws.role = 'broadcaster';
        // Previens tous les spectateurs deja connectes qu'un emetteur est dispo
        for (const [viewerId, v] of viewers) {
          send(broadcaster, { type: 'viewer-joined', viewerId, ip: v.ip, note: viewerNotes.get(v.ip) || '' });
        }
        break;
      }

      case 'viewer-join': {
        if (viewers.size >= MAX_VIEWERS) {
          send(ws, { type: 'auth-error', message: 'Nombre maximum de spectateurs atteint.' });
          ws.close();
          return;
        }
        ws.role = 'viewer';
        viewers.set(ws.id, ws);
        if (broadcaster) {
          send(broadcaster, { type: 'viewer-joined', viewerId: ws.id, ip: ws.ip, note: viewerNotes.get(ws.ip) || '' });
        }
        break;
      }

      // Relais WebRTC (offer/answer/ice) entre broadcaster et un viewer precis
      case 'offer': {
        // Seul le broadcaster authentifie peut initier une offre
        if (ws.role !== 'broadcaster') return;
        const target = viewers.get(msg.to);
        send(target, { ...msg, from: ws.id });
        break;
      }
      case 'answer':
      case 'ice-candidate': {
        if (msg.to === 'broadcaster') {
          // Seul un viewer enregistre peut repondre au broadcaster
          if (ws.role !== 'viewer') return;
          send(broadcaster, { ...msg, from: ws.id });
        } else {
          // Seul le broadcaster peut envoyer un ice-candidate a un viewer
          if (ws.role !== 'broadcaster') return;
          const target = viewers.get(msg.to);
          send(target, { ...msg, from: ws.id });
        }
        break;
      }

      case 'quality-request': {
        // Seul un viewer peut demander un changement de qualite
        if (ws.role !== 'viewer') return;
        if (broadcaster) {
          send(broadcaster, { type: 'quality-request', from: ws.id, quality: msg.quality });
        }
        break;
      }

      case 'chat-message': {
        // Seul un viewer peut envoyer ce type de message (destine au broadcaster)
        if (ws.role !== 'viewer') return;
        if (broadcaster) {
          send(broadcaster, {
            type: 'chat-message',
            from: ws.id,
            ip: ws.ip,
            text: String(msg.text || '').slice(0, 500),
            ts: Date.now()
          });
        }
        break;
      }

      case 'chat-reply': {
        // CRITIQUE : seul le broadcaster authentifie peut repondre en tant qu'emetteur
        if (ws.role !== 'broadcaster') return;
        const target = viewers.get(msg.to);
        send(target, {
          type: 'chat-message',
          from: 'broadcaster',
          text: String(msg.text || '').slice(0, 500),
          ts: Date.now()
        });
        break;
      }

      case 'set-note': {
        // CRITIQUE : seul le broadcaster authentifie peut modifier les notes
        if (ws.role !== 'broadcaster') return;
        const target = viewers.get(msg.viewerId);
        const ip = target ? target.ip : msg.ip;
        if (ip) {
          const note = String(msg.note || '').slice(0, 100);
          if (note) viewerNotes.set(ip, note);
          else viewerNotes.delete(ip);
          saveNotes(viewerNotes);
          send(broadcaster, { type: 'note-updated', viewerId: msg.viewerId, ip, note });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const c = connectionsPerIp.get(ws.ip) || 1;
    if (c <= 1) connectionsPerIp.delete(ws.ip);
    else connectionsPerIp.set(ws.ip, c - 1);

    if (ws.role === 'broadcaster' && broadcaster === ws) {
      broadcaster = null;
      for (const [, v] of viewers) send(v, { type: 'broadcaster-left' });
    } else if (ws.role === 'viewer') {
      viewers.delete(ws.id);
      if (broadcaster) send(broadcaster, { type: 'viewer-left', viewerId: ws.id, ip: ws.ip });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur pret sur http://localhost:${PORT}`);
  console.log(`Page emetteur : http://localhost:${PORT}/sender`);
  console.log(`Page spectateur : http://localhost:${PORT}/watch/room1`);
});
