'use strict';
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const db = require('./db');
const mod = require('./moderation');
const presence = require('./presence');
const session = require('./session');
const geo = require('./geo');
const profils = require('./profils');

const router = express.Router();

const RE_PSEUDO = /^[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 ._-]{1,22}[A-Za-zÀ-ÿ0-9]$/;
/* Se faire passer pour la modération est le premier abus d'un tchat anonyme. */
const RESERVES = ['admin', 'administrateur', 'moderateur', 'modérateur', 'modo', 'moderation', 'modération', 'chatnow', 'support', 'staff', 'systeme', 'système'];

const e = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const estSecurise = (req) =>
  req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

/* ------------------------------------------------------------------ *
 * Entrée dans le tchat                                                *
 * ------------------------------------------------------------------ */
router.post('/api/join', async (req, res) => {
  try {
    const pseudo = String(req.body.pseudo || '').replace(/\s+/g, ' ').trim();
    const age = parseInt(req.body.age, 10);
    const gender = profils.valide(req.body.gender) ? String(req.body.gender) : 'a';
    const region = String(req.body.region || '').trim().slice(0, 60) || null;
    const country = /^[A-Za-z]{2}$/.test(req.body.country || '') ? String(req.body.country).toUpperCase() : 'FR';
    const postal = geo.normalisePostal(req.body.postal).slice(0, 12);
    const cityNom = String(req.body.city || '').trim().slice(0, 120);

    if (!RE_PSEUDO.test(pseudo)) {
      return res.status(400).json({ ok: false, message: 'Pseudo invalide : 3 à 24 caractères, lettres et chiffres.' });
    }
    if (RESERVES.includes(pseudo.toLowerCase())) {
      return res.status(400).json({ ok: false, message: 'Ce pseudo est réservé.' });
    }
    if (mod.matchWords(pseudo).length) {
      return res.status(400).json({ ok: false, message: 'Ce pseudo ne respecte pas les règles du tchat.' });
    }
    if (!age || age < config.moderation.minAge || age > config.moderation.maxAge) {
      return res.status(400).json({ ok: false, message: `Âge requis, entre ${config.moderation.minAge} et ${config.moderation.maxAge} ans.` });
    }

    const ipHash = mod.hashIp(req.ip);
    const ban = await mod.isBanned({ ipHash, pseudo });
    if (ban) {
      return res.status(403).json({ ok: false, message: "L'accès au tchat vous a été retiré." + (ban.reason ? ' Motif : ' + ban.reason : '') });
    }
    if (presence.pseudoTaken(pseudo, session.readSession(req) || '')) {
      return res.status(409).json({ ok: false, message: 'Ce pseudo est déjà utilisé en ce moment. Choisissez-en un autre.' });
    }

    /* Le code postal est reverifie ICI, contre la base des communes. Le
       navigateur a beau proposer une liste, rien n'empeche d'envoyer autre
       chose : sans ce controle, on stockerait des coordonnees inventees et
       toutes les distances affichees seraient fausses. */
    let lieu = null;
    if (postal) {
      const communes = await geo.parCodePostal(postal, country);
      if (!communes.length) {
        return res.status(400).json({ ok: false, message: 'Code postal inconnu. Vérifiez-le, ou laissez le champ vide.' });
      }
      lieu = (cityNom && communes.find((c) => c.name === cityNom)) || communes[0];
    }

    /* On réutilise la session existante si le visiteur revient : il garde son
       historique privé et sa couleur, sans avoir à créer une seconde ligne. */
    let uid = session.readSession(req);
    if (uid && await db.one('SELECT id FROM visitors WHERE uid = ?', [uid])) {
      await db.run(
        `UPDATE visitors SET pseudo=?, age=?, gender=?, region=?, country=?, postal=?, city=?,
                             lat=?, lng=?, avatar_color=?, ip_hash=?, last_seen_at=NOW()
          WHERE uid=?`,
        [pseudo, age, gender, region, lieu ? lieu.country : null, lieu ? lieu.postal : null,
          lieu ? lieu.name : null, lieu ? lieu.lat : null, lieu ? lieu.lng : null,
          profils.couleur(gender), ipHash, uid]
      );
    } else {
      uid = session.newUid();
      await db.run(
        `INSERT INTO visitors (uid, pseudo, age, gender, region, country, postal, city, lat, lng,
                               avatar_color, ip_hash, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
        [uid, pseudo, age, gender, region, lieu ? lieu.country : null, lieu ? lieu.postal : null,
          lieu ? lieu.name : null, lieu ? lieu.lat : null, lieu ? lieu.lng : null,
          profils.couleur(gender), ipHash]
      );
    }
    session.setSession(res, uid, estSecurise(req));
    res.json({ ok: true, redirect: '/chat' });
  } catch (err) {
    res.status(500).json({ ok: false, message: 'Erreur serveur.' });
  }
});

router.post('/api/quit', (req, res) => {
  session.clearSession(res);
  res.json({ ok: true });
});

router.get('/api/rooms', async (req, res) => {
  const rooms = await db.query('SELECT slug, name, description, emoji, kind, min_age FROM rooms WHERE is_active = 1 ORDER BY position, id');
  const counts = presence.counts();
  res.json({
    ok: true,
    online: presence.online(),
    rooms: rooms.map((r) => ({ ...r, users: counts[r.slug] || 0 })),
  });
});

/* Recherche de commune : par code postal (?cp=31000) ou par nom (?q=toulou).
   Aucune API extérieure n'est appelée — tout vient de la table `cities`. */
router.get('/api/villes', async (req, res) => {
  try {
    const cp = String(req.query.cp || '').trim();
    const q = String(req.query.q || '').trim();
    const pays = /^[A-Za-z]{2}$/.test(req.query.pays || '') ? String(req.query.pays).toUpperCase() : null;
    const villes = cp ? await geo.parCodePostal(cp, pays) : (q ? await geo.parNom(q, 12) : []);
    res.json({
      ok: true,
      villes: villes.map((v) => ({ pays: v.country, cp: v.postal, nom: v.name, dept: v.dept, region: v.region })),
    });
  } catch (e) {
    res.json({ ok: false, villes: [] });
  }
});

router.get('/api/webrtc', (req, res) => {
  res.json({ ok: true, iceServers: config.iceServers, maxSpeakers: config.voiceMaxSpeakers });
});

router.get('/api/profils', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json({ ok: true, profils: profils.PROFILS });
});

router.get('/api/me', async (req, res) => {
  const uid = session.readSession(req);
  if (!uid) return res.json({ ok: false });
  const v = await db.one('SELECT uid, pseudo, age, gender, region, country, postal, city, avatar_color, role FROM visitors WHERE uid = ?', [uid]);
  res.json(v ? { ok: true, me: v } : { ok: false });
});

/* ------------------------------------------------------------------ *
 * Administration                                                      *
 * ------------------------------------------------------------------ */
const ADMIN_COOKIE = 'cn_adm';

function adminSign() {
  return crypto.createHmac('sha256', config.secret).update('admin|' + config.adminPassword).digest('base64url');
}

function estAdmin(req) {
  const c = session.parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  if (!c || !config.adminPassword) return false;
  const a = Buffer.from(c);
  const b = Buffer.from(adminSign());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const page = (titre, corps) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${e(titre)} — Administration</title><link rel="stylesheet" href="/css/admin.css"></head>
<body><header class="adm-top"><strong>${e(config.siteName)} — administration</strong>
<nav><a href="/admin">Tableau de bord</a><a href="/admin/rooms">Salons</a><a href="/admin/words">Mots filtrés</a>
<a href="/admin/reports">Signalements</a><a href="/admin/bans">Bannissements</a><a href="/admin/log">Journal</a>
<a href="/admin/logout" class="out">Quitter</a></nav></header><main class="adm">${corps}</main></body></html>`;

router.get('/admin/login', (req, res) => {
  if (estAdmin(req)) return res.redirect('/admin');
  res.send(page('Connexion', `<form method="post" action="/admin/login" class="card narrow">
<h1>Administration</h1>
${req.query.err ? '<p class="err">Mot de passe incorrect.</p>' : ''}
<label>Mot de passe<input type="password" name="password" autofocus required></label>
<button class="btn">Entrer</button></form>`));
});

router.post('/admin/login', (req, res) => {
  const fourni = String(req.body.password || '');
  const attendu = config.adminPassword;
  const a = Buffer.from(crypto.createHash('sha256').update(fourni).digest());
  const b = Buffer.from(crypto.createHash('sha256').update(attendu).digest());
  if (!attendu || !crypto.timingSafeEqual(a, b)) return res.redirect('/admin/login?err=1');
  const parts = [`${ADMIN_COOKIE}=${adminSign()}`, 'Path=/admin', 'HttpOnly', 'SameSite=Lax', 'Max-Age=28800'];
  if (estSecurise(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.redirect('/admin');
});

router.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/admin/login');
});

router.use('/admin', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  if (!estAdmin(req)) return res.redirect('/admin/login');
  next();
});

router.get('/admin', async (req, res) => {
  const [msg] = await db.query('SELECT COUNT(*) AS n FROM messages');
  const [msg24] = await db.query('SELECT COUNT(*) AS n FROM messages WHERE created_at > NOW() - INTERVAL 1 DAY');
  const [rep] = await db.query("SELECT COUNT(*) AS n FROM reports WHERE status='open'");
  const [bans] = await db.query('SELECT COUNT(*) AS n FROM bans WHERE expires_at IS NULL OR expires_at > NOW()');
  const [refus] = await db.query('SELECT COUNT(*) AS n FROM moderation_log WHERE created_at > NOW() - INTERVAL 1 DAY');
  const tops = await db.query(
    `SELECT r.name, COUNT(m.id) AS n FROM rooms r LEFT JOIN messages m
       ON m.room_id = r.id AND m.created_at > NOW() - INTERVAL 7 DAY
      GROUP BY r.id ORDER BY n DESC LIMIT 8`
  );
  res.send(page('Tableau de bord', `
<h1>Tableau de bord</h1>
<div class="tiles">
<div class="tile"><span class="n">${presence.online()}</span>connectés maintenant</div>
<div class="tile"><span class="n">${msg24.n}</span>messages (24 h)</div>
<div class="tile"><span class="n">${msg.n}</span>messages conservés</div>
<div class="tile ${rep.n ? 'warn' : ''}"><span class="n">${rep.n}</span>signalements en attente</div>
<div class="tile"><span class="n">${refus.n}</span>messages refusés (24 h)</div>
<div class="tile"><span class="n">${bans.n}</span>bannissements actifs</div>
</div>
<div class="card"><h2>Activité par salon (7 jours)</h2><table>
<tr><th>Salon</th><th>Messages</th></tr>
${tops.map((t) => `<tr><td>${e(t.name)}</td><td>${t.n}</td></tr>`).join('')}
</table></div>
<p class="muted">Les messages de plus de ${config.retentionDays} jours sont effacés automatiquement (RGPD).</p>`));
});

router.get('/admin/rooms', async (req, res) => {
  const rooms = await db.query('SELECT * FROM rooms ORDER BY position, id');
  const counts = presence.counts();
  res.send(page('Salons', `
<h1>Salons</h1>
<div class="card"><table>
<tr><th>Nom</th><th>Adresse</th><th>Type</th><th>Âge mini</th><th>Ordre</th><th>Connectés</th><th>État</th><th></th></tr>
${rooms.map((r) => `<tr><form method="post" action="/admin/rooms/${r.id}">
<td><input name="name" value="${e(r.name)}"><br><input name="description" value="${e(r.description || '')}" class="small"></td>
<td><code>/${e(r.slug)}</code></td>
<td><select name="kind">
<option value="text"${r.kind === 'text' ? ' selected' : ''}>Texte</option>
<option value="audio"${r.kind === 'audio' ? ' selected' : ''}>Micro</option>
<option value="radio"${r.kind === 'radio' ? ' selected' : ''}>Radio</option>
</select>${r.kind === 'radio' ? `<br><input name="stream_url" value="${e(r.stream_url || '')}" class="small" placeholder="adresse du flux radio">` : ''}</td>
<td><input name="min_age" type="number" min="0" max="99" value="${r.min_age}" class="mini"></td>
<td><input name="position" type="number" value="${r.position}" class="mini"></td>
<td>${counts[r.slug] || 0}</td>
<td><select name="is_active"><option value="1"${r.is_active ? ' selected' : ''}>Visible</option><option value="0"${!r.is_active ? ' selected' : ''}>Masqué</option></select></td>
<td><button class="btn small">Enregistrer</button></td></form></tr>`).join('')}
</table></div>
<form method="post" action="/admin/rooms" class="card narrow"><h2>Nouveau salon</h2>
<label>Nom<input name="name" required></label>
<label>Description<input name="description"></label>
<label>Emoji<input name="emoji" maxlength="4" value="💬"></label>
<label>Type de salon<select name="kind">
<option value="text">Texte — discussion écrite</option>
<option value="audio">Micro — on se parle à la voix</option>
<option value="radio">Radio — tout le monde écoute le même flux</option>
</select></label>
<label>Adresse du flux radio <span class="opt">(salons radio uniquement)</span><input name="stream_url" placeholder="https://…"></label>
<label>Âge minimum<input name="min_age" type="number" value="0" min="0" max="99"></label>
<button class="btn">Créer</button></form>
<p class="muted">Un salon micro fait circuler le son directement entre les navigateurs : il ne consomme
presque rien sur le serveur, mais le nombre de personnes au micro en même temps est limité
(réglage VOICE_MAX_SPEAKERS). Le micro exige une adresse en https.</p>`));
});

router.post('/admin/rooms', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name) {
    const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'salon';
    const [{ n }] = await db.query('SELECT COALESCE(MAX(position),0)+10 AS n FROM rooms');
    const kind = ['text', 'audio', 'radio'].includes(req.body.kind) ? req.body.kind : 'text';
    await db.run(
      'INSERT IGNORE INTO rooms (slug,name,description,emoji,kind,stream_url,min_age,position) VALUES (?,?,?,?,?,?,?,?)',
      [slug, name, String(req.body.description || '').slice(0, 190) || null,
        String(req.body.emoji || '💬').slice(0, 12), kind,
        String(req.body.stream_url || '').trim().slice(0, 255) || null,
        parseInt(req.body.min_age, 10) || 0, n]
    );
  }
  res.redirect('/admin/rooms');
});

router.post('/admin/rooms/:id', async (req, res) => {
  const kind = ['text', 'audio', 'radio'].includes(req.body.kind) ? req.body.kind : 'text';
  /* Le champ « flux » n'est affiché que sur les salons déjà en radio : sans ce
     COALESCE, éditer une autre ligne effacerait l'adresse enregistrée. */
  const flux = req.body.stream_url === undefined
    ? null : (String(req.body.stream_url).trim().slice(0, 255) || null);
  await db.run(
    `UPDATE rooms SET name=?, description=?, kind=?, min_age=?, position=?, is_active=?,
            stream_url = ${req.body.stream_url === undefined ? 'stream_url' : '?'}
      WHERE id=?`,
    req.body.stream_url === undefined
      ? [String(req.body.name || '').slice(0, 80), String(req.body.description || '').slice(0, 190) || null,
        kind, parseInt(req.body.min_age, 10) || 0, parseInt(req.body.position, 10) || 0,
        req.body.is_active === '1' ? 1 : 0, parseInt(req.params.id, 10)]
      : [String(req.body.name || '').slice(0, 80), String(req.body.description || '').slice(0, 190) || null,
        kind, parseInt(req.body.min_age, 10) || 0, parseInt(req.body.position, 10) || 0,
        req.body.is_active === '1' ? 1 : 0, flux, parseInt(req.params.id, 10)]
  );
  res.redirect('/admin/rooms');
});

router.get('/admin/words', async (req, res) => {
  const rows = await db.query('SELECT * FROM banned_words ORDER BY action, word');
  res.send(page('Mots filtrés', `
<h1>Mots filtrés</h1>
<p class="muted">« Masquer » remplace le mot par des étoiles. « Refuser » rejette tout le message.
Le filtre reconnaît les déguisements : c0nn4rd, c-o-n-n-a-r-d et cooonnard sont traités comme le mot lui-même.</p>
<form method="post" action="/admin/words" class="card narrow">
<label>Mot ou expression<input name="word" required></label>
<label>Action<select name="action"><option value="mask">Masquer</option><option value="block">Refuser le message</option></select></label>
<button class="btn">Ajouter</button></form>
<div class="card"><table><tr><th>Mot</th><th>Action</th><th></th></tr>
${rows.map((w) => `<tr><td>${e(w.word)}</td><td>${w.action === 'block' ? 'Refuser le message' : 'Masquer'}</td>
<td><form method="post" action="/admin/words/${w.id}/delete"><button class="btn small danger">Retirer</button></form></td></tr>`).join('')}
</table></div>`));
});

router.post('/admin/words', async (req, res) => {
  const word = String(req.body.word || '').trim().slice(0, 80);
  if (word) {
    await db.run('INSERT IGNORE INTO banned_words (word,action) VALUES (?,?)',
      [word, req.body.action === 'block' ? 'block' : 'mask']);
    await mod.reloadWords();
  }
  res.redirect('/admin/words');
});

router.post('/admin/words/:id/delete', async (req, res) => {
  await db.run('DELETE FROM banned_words WHERE id = ?', [parseInt(req.params.id, 10)]);
  await mod.reloadWords();
  res.redirect('/admin/words');
});

router.get('/admin/reports', async (req, res) => {
  const rows = await db.query("SELECT * FROM reports WHERE status='open' ORDER BY id DESC LIMIT 100");
  res.send(page('Signalements', `
<h1>Signalements en attente (${rows.length})</h1>
${rows.length ? '' : '<p class="muted">Aucun signalement en attente.</p>'}
${rows.map((r) => `<div class="card"><h2>${e(r.target_pseudo)}</h2>
<p class="muted">Signalé par ${e(r.reporter_pseudo || 'anonyme')} le ${e(r.created_at)}${r.reason ? ' — ' + e(r.reason) : ''}</p>
${r.context ? `<blockquote>${e(r.context)}</blockquote>` : ''}
<form method="post" action="/admin/reports/${r.id}" class="inline">
<input name="minutes" type="number" value="1440" class="mini" title="durée en minutes, 0 = définitif">
<button class="btn danger" name="do" value="ban">Bannir</button>
<button class="btn" name="do" value="close">Classer sans suite</button></form></div>`).join('')}`));
});

router.post('/admin/reports/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await db.one('SELECT * FROM reports WHERE id = ?', [id]);
  if (r && req.body.do === 'ban') {
    const minutes = parseInt(req.body.minutes, 10) || 0;
    /* On bannit sur le pseudo : l'empreinte d'IP du signalé n'est pas toujours
       connue au moment du signalement (la personne peut être déjà partie). */
    await db.run(
      `INSERT INTO bans (scope, value, reason, expires_at, created_by)
       VALUES ('pseudo', ?, ?, ${minutes ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'}, 'admin')
       ON DUPLICATE KEY UPDATE reason=VALUES(reason), expires_at=VALUES(expires_at)`,
      minutes ? [r.target_pseudo.toLowerCase(), 'Signalement #' + id, minutes] : [r.target_pseudo.toLowerCase(), 'Signalement #' + id]
    );
  }
  await db.run("UPDATE reports SET status='done' WHERE id = ?", [id]);
  res.redirect('/admin/reports');
});

router.get('/admin/bans', async (req, res) => {
  const rows = await db.query('SELECT * FROM bans ORDER BY id DESC LIMIT 200');
  res.send(page('Bannissements', `
<h1>Bannissements</h1>
<form method="post" action="/admin/bans" class="card narrow"><h2>Bannir un pseudo</h2>
<label>Pseudo<input name="value" required></label>
<label>Motif<input name="reason"></label>
<label>Durée en minutes (0 = définitif)<input name="minutes" type="number" value="1440"></label>
<button class="btn danger">Bannir</button></form>
<div class="card"><table><tr><th>Portée</th><th>Valeur</th><th>Motif</th><th>Jusqu'au</th><th></th></tr>
${rows.map((b) => `<tr><td>${b.scope === 'ip' ? 'Adresse IP' : 'Pseudo'}</td>
<td>${b.scope === 'ip' ? '<code>' + e(b.value.slice(0, 12)) + '…</code>' : e(b.value)}</td>
<td>${e(b.reason || '')}</td><td>${b.expires_at ? e(b.expires_at) : 'définitif'}</td>
<td><form method="post" action="/admin/bans/${b.id}/delete"><button class="btn small">Lever</button></form></td></tr>`).join('')}
</table></div>`));
});

router.post('/admin/bans', async (req, res) => {
  const value = String(req.body.value || '').trim().toLowerCase().slice(0, 64);
  if (value) {
    const minutes = parseInt(req.body.minutes, 10) || 0;
    await db.run(
      `INSERT INTO bans (scope, value, reason, expires_at, created_by)
       VALUES ('pseudo', ?, ?, ${minutes ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'}, 'admin')
       ON DUPLICATE KEY UPDATE reason=VALUES(reason), expires_at=VALUES(expires_at)`,
      minutes ? [value, String(req.body.reason || '').slice(0, 190), minutes] : [value, String(req.body.reason || '').slice(0, 190)]
    );
  }
  res.redirect('/admin/bans');
});

router.post('/admin/bans/:id/delete', async (req, res) => {
  await db.run('DELETE FROM bans WHERE id = ?', [parseInt(req.params.id, 10)]);
  res.redirect('/admin/bans');
});

router.get('/admin/log', async (req, res) => {
  const rows = await db.query('SELECT * FROM moderation_log ORDER BY id DESC LIMIT 200');
  res.send(page('Journal', `
<h1>Messages refusés par le filtre</h1>
<p class="muted">Sert à régler la liste : si un message normal apparaît ici, la règle est trop large.</p>
<div class="card"><table><tr><th>Date</th><th>Pseudo</th><th>Règle</th><th>Message</th></tr>
${rows.map((l) => `<tr><td>${e(l.created_at)}</td><td>${e(l.pseudo)}</td><td><code>${e(l.rule)}</code></td><td>${e(l.body || '')}</td></tr>`).join('')}
</table></div>`));
});

module.exports = router;
