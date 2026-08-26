'use strict';
/* Qui est connecté, et où. Tout est en mémoire : la présence est par nature
   volatile (elle ne survit pas à un redémarrage, et c'est normal), et la
   mettre en base voudrait dire écrire à chaque changement de salon. */

const bySocket = new Map();   // socket.id -> session
const byUid = new Map();      // uid       -> Set(socket.id)

function add(socketId, session) {
  bySocket.set(socketId, session);
  if (!byUid.has(session.uid)) byUid.set(session.uid, new Set());
  byUid.get(session.uid).add(socketId);
}

function remove(socketId) {
  const s = bySocket.get(socketId);
  if (!s) return null;
  bySocket.delete(socketId);
  const set = byUid.get(s.uid);
  if (set) {
    set.delete(socketId);
    if (!set.size) byUid.delete(s.uid);
  }
  return s;
}

const get = (socketId) => bySocket.get(socketId) || null;

/* Une même personne peut avoir deux onglets ouverts. Elle ne doit apparaître
   qu'une fois dans la liste des connectés du salon. */
function inRoom(slug) {
  const vus = new Map();
  for (const s of bySocket.values()) {
    if (s.room === slug && !vus.has(s.uid)) vus.set(s.uid, s);
  }
  return [...vus.values()];
}

function counts() {
  const c = {};
  const vus = new Set();
  for (const s of bySocket.values()) {
    if (!s.room) continue;
    const k = s.room + '|' + s.uid;
    if (vus.has(k)) continue;
    vus.add(k);
    c[s.room] = (c[s.room] || 0) + 1;
  }
  return c;
}

function online() {
  return byUid.size;
}

const socketsOf = (uid) => [...(byUid.get(uid) || [])];

const isOnline = (uid) => byUid.has(uid);

/* Le pseudo est unique parmi les personnes CONNECTÉES, pas dans toute la base :
   sur un tchat anonyme, réserver un pseudo à vie viderait vite la réserve de
   pseudos disponibles. */
function pseudoTaken(pseudo, exceptUid) {
  const p = String(pseudo).toLowerCase();
  for (const s of bySocket.values()) {
    if (s.uid !== exceptUid && s.pseudo.toLowerCase() === p) return true;
  }
  return false;
}

function findByPseudo(pseudo) {
  const p = String(pseudo).toLowerCase();
  for (const s of bySocket.values()) if (s.pseudo.toLowerCase() === p) return s;
  return null;
}

const all = () => [...bySocket.values()];

module.exports = { add, remove, get, inRoom, counts, online, socketsOf, isOnline, pseudoTaken, findByPseudo, all };
