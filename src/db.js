'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...config.db,
      waitForConnections: true,
      queueLimit: 0,
      charset: 'utf8mb4_unicode_ci',
      /* Les dates sont renvoyées en chaîne : sans cela, mysql2 fabrique un
         objet Date dans le fuseau du serveur Node, qui n'est pas forcément
         celui de MySQL, et l'heure des messages se décale d'une heure. */
      dateStrings: true,
    });
  }
  return pool;
}

const query = async (sql, params = []) => {
  const [rows] = await getPool().execute(sql, params);
  return rows;
};

const one = async (sql, params = []) => (await query(sql, params))[0] || null;

const run = async (sql, params = []) => {
  const [res] = await getPool().execute(sql, params);
  return res;
};

/* Salons livrés par défaut. Ils ne sont insérés qu'une seule fois : si le
   client les renomme ou les supprime depuis l'administration, un redémarrage
   ne doit surtout pas les faire réapparaître. D'où le compteur global. */
const DEFAULT_ROOMS = [
  ['general', 'Général', 'Le salon principal, on parle de tout.', '💬', 0, 10],
  ['rencontres', 'Rencontres', 'Faire connaissance, discuter, se rencontrer.', '💛', 18, 20],
  ['amitie', 'Amitié', 'Trouver des amis, parler simplement.', '🤝', 0, 30],
  ['18-25', '18-25 ans', 'Le salon des plus jeunes majeurs.', '🎓', 18, 40],
  ['25-40', '25-40 ans', 'Discussions entre 25 et 40 ans.', '☕', 18, 50],
  ['40plus', '40 ans et +', 'Le salon des plus de 40 ans.', '🌿', 18, 60],
  ['detente', 'Détente', 'Humour, blagues, discussions légères.', '😄', 0, 70],
  ['musique-cine', 'Musique & Ciné', 'Films, séries, musique, sorties.', '🎬', 0, 80],
  ['jeux-video', 'Jeux vidéo', 'Consoles, PC, parties en ligne.', '🎮', 0, 90],
  ['sport', 'Sport', 'Foot, running, salle, tous les sports.', '⚽', 0, 100],
  ['entraide', 'Aide & Soutien', 'Une oreille attentive, sans jugement.', '💙', 0, 110],
];

/* Liste de départ du filtre. Volontairement courte et centrée sur ce qui est
   illégal ou gravement injurieux : une liste trop large bloque des messages
   normaux et les visiteurs partent. Elle s'enrichit depuis l'administration,
   en lisant le journal de modération. */
const DEFAULT_WORDS = [
  ['connard', 'mask'], ['connasse', 'mask'], ['salope', 'mask'], ['pute', 'mask'],
  ['enculé', 'mask'], ['encule', 'mask'], ['batard', 'mask'], ['bâtard', 'mask'],
  ['ntm', 'mask'], ['fdp', 'mask'], ['pd', 'mask'], ['tapette', 'mask'],
  ['negre', 'block'], ['nègre', 'block'], ['bougnoule', 'block'], ['youpin', 'block'],
  ['pedophile', 'block'], ['pédophile', 'block'], ['pedo', 'block'],
  ['viol', 'block'], ['zoophilie', 'block'], ['inceste', 'block'],
  ['nudes', 'block'], ['snap sexe', 'block'], ['cocaine', 'block'], ['cocaïne', 'block'],
];

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }

  const [{ n: nbRooms }] = await query('SELECT COUNT(*) AS n FROM rooms');
  if (Number(nbRooms) === 0) {
    for (const r of DEFAULT_ROOMS) {
      await run(
        'INSERT INTO rooms (slug,name,description,emoji,min_age,position) VALUES (?,?,?,?,?,?)',
        r
      );
    }
  }

  const [{ n: nbWords }] = await query('SELECT COUNT(*) AS n FROM banned_words');
  if (Number(nbWords) === 0) {
    for (const [word, action] of DEFAULT_WORDS) {
      await run('INSERT IGNORE INTO banned_words (word,action) VALUES (?,?)', [word, action]);
    }
  }
}

/* Purge RGPD. Les messages ne sont pas conservés indéfiniment : au-delà du
   délai de rétention ils sont effacés, ainsi que les sessions anonymes
   inactives, dont on n'a plus aucune raison de garder l'empreinte d'IP. */
async function purge() {
  const d = config.retentionDays;
  const res = {};
  res.messages = (await run('DELETE FROM messages WHERE created_at < (NOW() - INTERVAL ? DAY)', [d])).affectedRows;
  res.privateMessages = (await run('DELETE FROM private_messages WHERE created_at < (NOW() - INTERVAL ? DAY)', [d])).affectedRows;
  res.moderationLog = (await run('DELETE FROM moderation_log WHERE created_at < (NOW() - INTERVAL ? DAY)', [d])).affectedRows;
  res.visitors = (await run(
    'DELETE FROM visitors WHERE role = ? AND (last_seen_at IS NULL OR last_seen_at < (NOW() - INTERVAL ? DAY))',
    ['user', d]
  )).affectedRows;
  /* Un bannissement expiré doit disparaître tout seul, sinon la table enfle et
     la vérification à l'entrée ralentit. */
  res.bans = (await run('DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at < NOW()')).affectedRows;
  return res;
}

module.exports = { getPool, query, one, run, migrate, purge, DEFAULT_ROOMS };
