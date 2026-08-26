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
/* Colonnes : slug, nom, description, emoji, type, âge mini, ordre.
   Type : « text » (par défaut), « audio » (micro) ou « radio » (flux écouté
   ensemble). L'adresse du flux radio se saisit dans l'administration : elle
   dépend du site, on ne peut pas en livrer une par défaut. */
const DEFAULT_ROOMS = [
  ['general', 'Général', 'Le salon principal, on parle de tout.', '💬', 'text', 0, 10],
  ['rencontres', 'Rencontres', 'Faire connaissance, discuter, se rencontrer.', '💛', 'text', 18, 20],
  ['amitie', 'Amitié', 'Trouver des amis, parler simplement.', '🤝', 'text', 0, 30],
  ['micro', 'Salon micro', 'On se parle à la voix, sans caméra.', '🎙️', 'audio', 18, 35],
  ['radio', 'Radio', 'On écoute la même radio et on en parle.', '📻', 'radio', 0, 38],
  ['18-25', '18-25 ans', 'Le salon des plus jeunes majeurs.', '🎓', 'text', 18, 40],
  ['25-40', '25-40 ans', 'Discussions entre 25 et 40 ans.', '☕', 'text', 18, 50],
  ['40plus', '40 ans et +', 'Le salon des plus de 40 ans.', '🌿', 'text', 18, 60],
  ['detente', 'Détente', 'Humour, blagues, discussions légères.', '😄', 'text', 0, 70],
  ['musique-cine', 'Musique & Ciné', 'Films, séries, musique, sorties.', '🎬', 'text', 0, 80],
  ['jeux-video', 'Jeux vidéo', 'Consoles, PC, parties en ligne.', '🎮', 'text', 0, 90],
  ['sport', 'Sport', 'Foot, running, salle, tous les sports.', '⚽', 'text', 0, 100],
  ['entraide', 'Aide & Soutien', 'Une oreille attentive, sans jugement.', '💙', 'text', 0, 110],
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

/* `CREATE TABLE IF NOT EXISTS` ne touche pas une table qui existe déjà : sur
   une base en service, une colonne ajoutée après coup ne serait jamais créée
   et le site tomberait sur « Unknown column ». D'où ces deux aides, qui ne
   font rien quand l'objet est déjà là. */
async function colonneExiste(table, colonne) {
  const r = await one(
    `SELECT 1 AS ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, colonne]
  );
  return !!r;
}

async function ajouteColonne(table, colonne, definition) {
  if (await colonneExiste(table, colonne)) return false;
  await run(`ALTER TABLE \`${table}\` ADD COLUMN \`${colonne}\` ${definition}`);
  return true;
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }

  /* Profil (homme, femme, couple, gay…) : une colonne texte plutôt qu'un ENUM,
     pour qu'ajouter un profil plus tard ne demande aucune migration. */
  await run("ALTER TABLE visitors MODIFY COLUMN gender VARCHAR(12) NOT NULL DEFAULT 'a'");
  await ajouteColonne('visitors', 'country', "CHAR(2) NULL AFTER region");
  await ajouteColonne('visitors', 'postal', "VARCHAR(12) NULL AFTER country");
  await ajouteColonne('visitors', 'city', "VARCHAR(120) NULL AFTER postal");
  await ajouteColonne('visitors', 'lat', 'DECIMAL(9,6) NULL AFTER city');
  await ajouteColonne('visitors', 'lng', 'DECIMAL(9,6) NULL AFTER lat');
  await ajouteColonne('rooms', 'kind', "VARCHAR(12) NOT NULL DEFAULT 'text' AFTER emoji");
  await ajouteColonne('rooms', 'stream_url', 'VARCHAR(255) NULL AFTER kind');

  const [{ n: nbRooms }] = await query('SELECT COUNT(*) AS n FROM rooms');
  if (Number(nbRooms) === 0) {
    for (const r of DEFAULT_ROOMS) {
      await run(
        'INSERT INTO rooms (slug,name,description,emoji,kind,min_age,position) VALUES (?,?,?,?,?,?,?)',
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
