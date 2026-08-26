'use strict';

const config = require('./config');
const db = require('./db');
const mod = require('./moderation');
const presence = require('./presence');
const session = require('./session');

/* mysql2 en mode « execute » (requête préparée) refuse un paramètre sur LIMIT :
   MySQL le reçoit comme une chaîne et répond « Incorrect arguments ». On
   force donc un entier, borné, que l'on écrit directement dans la requête. */
const lim = (n, max = 200) => Math.max(1, Math.min(max, parseInt(n, 10) || 1));

/* Les coordonnées envoyées au navigateur sont arrondies à deux décimales, soit
   environ un kilomètre. C'est assez pour calculer une distance chez le
   visiteur — donc sans faire travailler le serveur pour chaque paire — et trop
   grossier pour situer qui que ce soit. Le nom de la commune, lui, est déjà
   affiché : on ne divulgue rien de plus.
   La position exacte de la personne n'est de toute façon jamais connue : on ne
   stocke que le centre de sa commune. */
const arrondi = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);

const publicUser = (s) => ({
  uid: s.uid, pseudo: s.pseudo, age: s.age, gender: s.gender,
  region: s.region, city: s.city, country: s.country,
  lat: arrondi(s.lat), lng: arrondi(s.lng),
  color: s.color, role: s.role, voice: !!s.voice,
});

function ipOf(socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (config.trustProxy && xff) return String(xff).split(',')[0].trim();
  return socket.handshake.address;
}

async function roomBySlug(slug) {
  return db.one('SELECT * FROM rooms WHERE slug = ? AND is_active = 1', [String(slug || '')]);
}

async function listRooms() {
  return db.query(
    `SELECT slug, name, description, emoji, kind, stream_url, min_age
       FROM rooms WHERE is_active = 1 ORDER BY position, id`
  );
}

function attach(io) {
  /* ---------------- authentification de la connexion ---------------- */
  io.use(async (socket, next) => {
    try {
      const cookies = session.parseCookies(socket.handshake.headers.cookie);
      const uid = cookies[session.COOKIE] ? session.verify(cookies[session.COOKIE]) : null;
      if (!uid) return next(new Error('no-session'));

      const v = await db.one('SELECT * FROM visitors WHERE uid = ?', [uid]);
      if (!v) return next(new Error('no-session'));

      const ipHash = mod.hashIp(ipOf(socket));
      const ban = await mod.isBanned({ ipHash, pseudo: v.pseudo });
      if (ban) return next(new Error('banned:' + (ban.reason || '')));

      socket.data.session = {
        uid: v.uid, visitorId: v.id, pseudo: v.pseudo, age: v.age, gender: v.gender,
        region: v.region, country: v.country, postal: v.postal, city: v.city,
        lat: v.lat, lng: v.lng,
        color: v.avatar_color, role: v.role, ipHash,
        room: null, ignored: new Set(),
      };
      next();
    } catch (e) {
      next(new Error('server'));
    }
  });

  io.on('connection', async (socket) => {
    const s = socket.data.session;
    presence.add(socket.id, s);

    const diffuseSalons = () => io.emit('counts', { rooms: presence.counts(), online: presence.online() });
    const diffuseMembres = (slug) => {
      if (slug) io.to('room:' + slug).emit('users', presence.inRoom(slug).map(publicUser));
    };

    socket.emit('session', publicUser(s));
    socket.emit('rooms', await listRooms());
    diffuseSalons();

    /* --------------------------- salons --------------------------- */
    socket.on('room:join', async (payload, ack) => {
      try {
        const room = await roomBySlug(payload && payload.slug);
        if (!room) return ack && ack({ ok: false, message: "Ce salon n'existe pas." });
        if (room.min_age && (!s.age || s.age < room.min_age)) {
          return ack && ack({ ok: false, message: `Ce salon est réservé aux ${room.min_age} ans et plus.` });
        }

        const ancien = s.room;
        if (ancien === room.slug) return ack && ack({ ok: true, already: true });
        if (ancien && s.voice) {
          /* Changer de salon en gardant le micro ouvert laisserait la voix
             dans l'ancien salon, sans plus personne pour la couper. */
          s.voice = false;
          socket.to('room:' + ancien).emit('voice:peer', { uid: s.uid, on: false });
        }
        if (ancien) {
          socket.leave('room:' + ancien);
          socket.to('room:' + ancien).emit('system', { text: `${s.pseudo} a quitté le salon.`, kind: 'leave' });
        }
        s.room = room.slug;
        socket.join('room:' + room.slug);

        const rows = await db.query(
          `SELECT id, pseudo, avatar_color AS color, body, kind, created_at
             FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ${lim(config.historyMessages)}`,
          [room.id]
        );
        socket.emit('room:joined', {
          room: {
            slug: room.slug, name: room.name, description: room.description,
            emoji: room.emoji, kind: room.kind || 'text', stream_url: room.stream_url || null,
          },
          history: rows.reverse(),
          users: presence.inRoom(room.slug).map(publicUser),
        });
        socket.to('room:' + room.slug).emit('system', { text: `${s.pseudo} a rejoint le salon.`, kind: 'join' });

        diffuseMembres(room.slug);
        if (ancien) diffuseMembres(ancien);
        diffuseSalons();
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ ok: false, message: 'Erreur serveur.' });
      }
    });

    /* ------------------------ message public ---------------------- */
    socket.on('message:send', async (payload, ack) => {
      try {
        if (!s.room) return ack && ack({ ok: false, message: "Choisissez d'abord un salon." });

        const brut = String((payload && payload.body) || '');
        const flood = mod.floodCheck(s.uid, brut.trim());
        if (!flood.ok) {
          const message = flood.rule === 'repeat'
            ? "Vous venez d'envoyer ce message."
            : `Vous envoyez trop vite. Patientez ${flood.wait} secondes.`;
          return ack && ack({ ok: false, message });
        }

        /* Un modérateur doit pouvoir coller un lien (règlement, page d'aide)
           sans que le filtre anti-spam ne l'en empêche. */
        const priv = s.role !== 'user';
        const v = mod.checkMessage(brut, { skipLinks: priv, skipContact: priv });
        if (!v.ok) {
          mod.logRefus(s.pseudo, s.ipHash, v.rule, brut);
          return ack && ack({ ok: false, message: v.message });
        }

        const room = await roomBySlug(s.room);
        if (!room) return ack && ack({ ok: false, message: 'Salon introuvable.' });

        const res = await db.run(
          `INSERT INTO messages (room_id, visitor_id, pseudo, avatar_color, body, kind, ip_hash, created_at)
           VALUES (?,?,?,?,?,'user',?,NOW())`,
          [room.id, s.visitorId, s.pseudo, s.color, v.text, s.ipHash]
        );

        io.to('room:' + s.room).emit('message', {
          id: res.insertId, uid: s.uid, pseudo: s.pseudo, color: s.color,
          role: s.role, body: v.text, created_at: new Date().toISOString(),
        });
        db.run('UPDATE visitors SET last_seen_at = NOW() WHERE id = ?', [s.visitorId]).catch(() => {});
        ack && ack({ ok: true, masked: v.masked });
      } catch (e) {
        ack && ack({ ok: false, message: 'Erreur serveur.' });
      }
    });

    /* ------------------- « est en train d'écrire » ----------------- */
    socket.on('typing', (payload) => {
      if (!s.room) return;
      socket.to('room:' + s.room).emit('typing', { uid: s.uid, pseudo: s.pseudo, on: !!(payload && payload.on) });
    });

    /* -------------------------- privé ----------------------------- */
    socket.on('pm:send', async (payload, ack) => {
      try {
        const to = String((payload && payload.to) || '');
        const cible = presence.all().find((u) => u.uid === to);
        if (!cible) return ack && ack({ ok: false, message: "Cette personne n'est plus connectée." });
        if (cible.ignored && cible.ignored.has(s.uid)) {
          /* On ne dit pas « vous êtes ignoré » : cela transformerait le blocage
             en information exploitable pour insister autrement. Le message part
             dans le vide, c'est tout. */
          return ack && ack({ ok: true });
        }

        const flood = mod.floodCheck('pm:' + s.uid, String((payload && payload.body) || '').trim());
        if (!flood.ok) return ack && ack({ ok: false, message: 'Vous envoyez trop vite.' });

        const priv = s.role !== 'user';
        const v = mod.checkMessage((payload && payload.body) || '', { skipLinks: priv, skipContact: true });
        if (!v.ok) {
          mod.logRefus(s.pseudo, s.ipHash, 'pm:' + v.rule, (payload && payload.body) || '');
          return ack && ack({ ok: false, message: v.message });
        }

        await db.run(
          'INSERT INTO private_messages (from_uid, to_uid, from_pseudo, body, created_at) VALUES (?,?,?,?,NOW())',
          [s.uid, to, s.pseudo, v.text]
        );
        const enveloppe = {
          from: s.uid, fromPseudo: s.pseudo, color: s.color,
          to, body: v.text, created_at: new Date().toISOString(),
        };
        presence.socketsOf(to).forEach((id) => io.to(id).emit('pm', enveloppe));
        /* Renvoyé aussi à l'expéditeur : il peut avoir plusieurs onglets
           ouverts, et sa conversation doit rester identique partout. */
        presence.socketsOf(s.uid).forEach((id) => io.to(id).emit('pm', enveloppe));
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ ok: false, message: 'Erreur serveur.' });
      }
    });

    socket.on('pm:history', async (payload, ack) => {
      try {
        const to = String((payload && payload.with) || '');
        const rows = await db.query(
          `SELECT from_uid, from_pseudo, body, created_at FROM private_messages
            WHERE (from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)
            ORDER BY id DESC LIMIT ${lim(50)}`,
          [s.uid, to, to, s.uid]
        );
        ack && ack({ ok: true, messages: rows.reverse() });
      } catch (e) {
        ack && ack({ ok: false, messages: [] });
      }
    });

    /* ------------------------- ignorer ---------------------------- */
    socket.on('ignore', (payload, ack) => {
      const uid = String((payload && payload.uid) || '');
      if (!uid || uid === s.uid) return ack && ack({ ok: false });
      if (payload.on) s.ignored.add(uid); else s.ignored.delete(uid);
      ack && ack({ ok: true, ignored: [...s.ignored] });
    });

    /* ------------------------ signalement ------------------------- */
    socket.on('report', async (payload, ack) => {
      try {
        const cible = String((payload && payload.pseudo) || '').slice(0, 24);
        if (!cible) return ack && ack({ ok: false });
        const u = presence.findByPseudo(cible);
        await db.run(
          `INSERT INTO reports (message_id, target_pseudo, target_uid, reporter_uid, reporter_pseudo, context, reason, created_at)
           VALUES (?,?,?,?,?,?,?,NOW())`,
          [
            payload.messageId ? parseInt(payload.messageId, 10) : null,
            cible, u ? u.uid : null, s.uid, s.pseudo,
            String(payload.context || '').slice(0, 1000),
            String(payload.reason || '').slice(0, 190),
          ]
        );
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ ok: false });
      }
    });

    /* --------------------- outils de modération ------------------- */
    socket.on('mod:action', async (payload, ack) => {
      if (s.role === 'user') return ack && ack({ ok: false, message: 'Action réservée à la modération.' });
      try {
        const cible = presence.findByPseudo(String((payload && payload.pseudo) || ''));
        if (!cible) return ack && ack({ ok: false, message: 'Personne introuvable.' });
        if (cible.role !== 'user') return ack && ack({ ok: false, message: 'Impossible sur un membre de la modération.' });

        const minutes = Math.max(0, parseInt(payload.minutes, 10) || 0);
        if (payload.action === 'ban') {
          await db.run(
            `INSERT INTO bans (scope, value, reason, expires_at, created_by)
             VALUES ('ip', ?, ?, ${minutes ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'}, ?)
             ON DUPLICATE KEY UPDATE reason = VALUES(reason), expires_at = VALUES(expires_at)`,
            minutes
              ? [cible.ipHash, String(payload.reason || '').slice(0, 190), minutes, s.pseudo]
              : [cible.ipHash, String(payload.reason || '').slice(0, 190), s.pseudo]
          );
        }
        presence.socketsOf(cible.uid).forEach((id) => {
          io.to(id).emit('kicked', { reason: String(payload.reason || '') , banned: payload.action === 'ban' });
          const sock = io.sockets.sockets.get(id);
          if (sock) sock.disconnect(true);
        });
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ ok: false, message: 'Erreur serveur.' });
      }
    });

    /* --------------------------- micro ---------------------------- *
     * Le son ne passe PAS par le serveur : chaque navigateur se connecte
     * directement aux autres (WebRTC). Le serveur ne fait que transmettre
     * les messages de mise en relation. C'est ce qui permet de tenir un
     * salon audio sur un petit VPS — mais c'est aussi pourquoi le nombre de
     * participants au micro doit rester limité : chacun envoie son flux à
     * tous les autres.
     * ------------------------------------------------------------------ */
    socket.on('voice:join', async (payload, ack) => {
      try {
        if (!s.room) return ack && ack({ ok: false, message: "Rejoignez d'abord un salon." });
        const room = await roomBySlug(s.room);
        if (!room || room.kind !== 'audio') {
          return ack && ack({ ok: false, message: "Ce salon n'a pas de micro." });
        }
        const deja = presence.inRoom(s.room).filter((u) => u.voice && u.uid !== s.uid);
        if (deja.length >= config.voiceMaxSpeakers) {
          return ack && ack({ ok: false, message: `Le micro est complet (${config.voiceMaxSpeakers} personnes maximum).` });
        }
        s.voice = true;
        socket.to('room:' + s.room).emit('voice:peer', { uid: s.uid, pseudo: s.pseudo, color: s.color, on: true });
        io.to('room:' + s.room).emit('users', presence.inRoom(s.room).map(publicUser));
        ack && ack({ ok: true, pairs: deja.map((u) => ({ uid: u.uid, pseudo: u.pseudo, color: u.color })) });
      } catch (e) {
        ack && ack({ ok: false, message: 'Erreur serveur.' });
      }
    });

    const quitteMicro = () => {
      if (!s.voice) return;
      s.voice = false;
      if (s.room) {
        socket.to('room:' + s.room).emit('voice:peer', { uid: s.uid, on: false });
        io.to('room:' + s.room).emit('users', presence.inRoom(s.room).map(publicUser));
      }
    };
    socket.on('voice:leave', () => quitteMicro());

    /* Relais de mise en relation. On ne transmet qu'aux personnes présentes
       dans le MÊME salon : sans ce contrôle, n'importe qui pourrait ouvrir
       une connexion audio vers n'importe quel visiteur du site. */
    socket.on('voice:signal', (payload) => {
      const to = String((payload && payload.to) || '');
      if (!to || !s.room) return;
      const cible = presence.inRoom(s.room).find((u) => u.uid === to);
      if (!cible) return;
      presence.socketsOf(to).forEach((id) => {
        io.to(id).emit('voice:signal', { from: s.uid, pseudo: s.pseudo, data: payload.data });
      });
    });

    /* ------------------------ déconnexion ------------------------- */
    socket.on('disconnect', () => {
      quitteMicro();
      const parti = presence.remove(socket.id);
      if (!parti) return;
      /* Un seul onglet fermé sur deux ne fait pas quitter le salon. */
      if (parti.room && !presence.isOnline(parti.uid)) {
        socket.to('room:' + parti.room).emit('system', { text: `${parti.pseudo} a quitté le salon.`, kind: 'leave' });
        mod.forgetFlood(parti.uid);
      }
      if (parti.room) io.to('room:' + parti.room).emit('users', presence.inRoom(parti.room).map(publicUser));
      io.emit('counts', { rooms: presence.counts(), online: presence.online() });
      db.run('UPDATE visitors SET last_seen_at = NOW() WHERE id = ?', [parti.visitorId]).catch(() => {});
    });
  });
}

module.exports = { attach, publicUser };
