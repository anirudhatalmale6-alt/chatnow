'use strict';
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

/* ------------------------------------------------------------------ *
 * Normalisation                                                       *
 * ------------------------------------------------------------------ *
 * Un filtre qui compare bêtement les caractères ne bloque rien du tout :
 * « c0nn4rd », « C-O-N-N-A-R-D » et « coooonnard » passent tous. On ramène
 * donc le message à une forme canonique AVANT de chercher les mots.        */

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '€': 'e', '!': 'i' };

/* Forme canonique : minuscules, sans accent, chiffres « leet » retraduits.
   Les répétitions ne sont volontairement PAS réduites ici — l'ordre compte,
   voir le commentaire de colle(). */
function canon(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // accents : é -> e
    .replace(/[013457@$€!]/g, (c) => LEET[c] || c);
}

const normalise = (text) => canon(text).replace(/(.)\1+/g, '$1');   // cooonnard -> conard

/* Version « collée » : séparateurs retirés PUIS répétitions réduites. Dans
   l'autre ordre, « c-o-n-n-a-r-d » donnerait « connard » quand le mot de
   référence donne « conard » : la comparaison échouerait sans rien signaler. */
const colle = (text) => canon(text).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');

/* On ne colle jamais le message entier : « il porte une salopette » contient
   « salope » une fois les espaces retirés, et le message serait refusé à tort.
   On n'extrait donc que les passages réellement déguisés — les suites de
   lettres isolées : « c o n n a r d », « c.o.n.n.a.r.d ». */
const RE_ESPACE = /(?:[a-z][^a-z]+){3,}[a-z]/g;
const passagesDeguises = (text) =>
  (canon(text).match(RE_ESPACE) || []).map((r) => r.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1'));

/* ------------------------------------------------------------------ *
 * Liste de mots (en mémoire, rechargée après chaque modification)     *
 * ------------------------------------------------------------------ */
let words = [];

async function reloadWords() {
  const rows = await db.query('SELECT word, action FROM banned_words');
  words = rows.map((r) => {
    const n = normalise(r.word);
    return {
      word: r.word,
      action: r.action,
      norm: n,
      colle: colle(r.word),
      /* \b ne fonctionne pas après normalisation sur des mots contenant un
         espace ; on borne donc explicitement par « pas une lettre ». */
      re: new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`),
    };
  });
  return words.length;
}

function matchWords(text) {
  const n = normalise(text);
  const deguises = passagesDeguises(text);
  const hits = [];
  for (const w of words) {
    if (w.re.test(n)) { hits.push(w); continue; }
    if (w.colle.length >= 4 && deguises.some((d) => d.includes(w.colle))) hits.push(w);
  }
  return hits;
}

function maskWords(text, hits) {
  let out = text;
  for (const w of hits) {
    /* On masque sur le texte d'origine : le visiteur doit reconnaître sa
       phrase, seul le mot est étoilé. Les variantes déguisées (« c0nn4rd »)
       ne sont pas retrouvées ici — c'est voulu : dans ce cas le message est
       de toute façon refusé plus loin si le mot est en « block ». */
    const re = new RegExp(w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Anti-flood                                                          *
 * ------------------------------------------------------------------ *
 * En mémoire volontairement : un compteur anti-flood n'a aucun intérêt à
 * survivre à un redémarrage, et l'écrire en base ajouterait une requête à
 * chaque message envoyé.                                                  */
const buckets = new Map();   // clé -> { times: [], mutedUntil, last }

function floodCheck(key, body) {
  const now = Date.now();
  const b = buckets.get(key) || { times: [], mutedUntil: 0, last: '' };
  if (b.mutedUntil > now) {
    return { ok: false, rule: 'flood', wait: Math.ceil((b.mutedUntil - now) / 1000) };
  }
  /* Répéter mot pour mot le message précédent est la forme de spam la plus
     courante ; on la refuse sans attendre le quota. */
  if (body && b.last === body) {
    buckets.set(key, b);
    return { ok: false, rule: 'repeat' };
  }
  b.times = b.times.filter((t) => now - t < config.moderation.floodWindowMs);
  b.times.push(now);
  if (b.times.length > config.moderation.floodMaxMessages) {
    b.mutedUntil = now + config.moderation.floodMuteSeconds * 1000;
    b.times = [];
    buckets.set(key, b);
    return { ok: false, rule: 'flood', wait: config.moderation.floodMuteSeconds };
  }
  b.last = body || b.last;
  buckets.set(key, b);
  return { ok: true };
}

/* Le seau d'un visiteur parti n'a plus de raison d'occuper la mémoire. */
function forgetFlood(key) { buckets.delete(key); }

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.mutedUntil < now && (!b.times.length || now - b.times[b.times.length - 1] > 600000)) buckets.delete(k);
  }
}, 300000).unref();

/* ------------------------------------------------------------------ *
 * Contrôle complet d'un message                                       *
 * ------------------------------------------------------------------ */
const RE_LIEN = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:fr|com|net|org|io|be|ch|ca|eu|me|tv|xyz|top|link|ru)\b)/i;
const RE_TEL = /(?:\+\d{1,3}[\s.-]?)?(?:\d[\s.-]?){9,}/;
const RE_MAIL = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
/* Un pseudo Snapchat / Telegram sert à emmener la personne hors du site, là où
   plus aucune modération ne s'applique. Sur un tchat ouvert aux mineurs, c'est
   le premier réflexe des comptes malveillants. */
const RE_RESEAU = /\b(snap(chat)?|telegram|whats?app|insta(gram)?|kik)\b\s*[:=]?\s*[\w.@-]{3,}/i;

function checkMessage(body, opts = {}) {
  const raw = String(body || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { ok: false, rule: 'empty', message: 'Message vide.' };
  if (raw.length > config.moderation.maxMessageLength) {
    return { ok: false, rule: 'length', message: `Message trop long (${config.moderation.maxMessageLength} caractères maximum).` };
  }

  let text = raw;

  /* CRIER EN MAJUSCULES tout le temps rend un salon illisible. On ne refuse
     pas le message, on le remet simplement en minuscules. */
  const lettres = text.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  if (lettres.length > 15) {
    const majuscules = (text.match(/[A-ZÀ-ÖØ-Þ]/g) || []).length;
    if (majuscules / lettres.length > 0.7) {
      text = text.charAt(0) + text.slice(1).toLowerCase();
    }
  }

  /* Les coordonnées sont contrôlées AVANT les liens : une adresse e-mail
     contient un nom de domaine, elle déclencherait sinon la règle « lien » et
     le visiteur lirait « les liens sont interdits » alors qu'il a écrit son
     adresse. Le message d'erreur doit désigner la vraie raison. */
  if (!opts.skipContact && config.moderation.blockContactDetails) {
    if (RE_MAIL.test(text)) {
      return { ok: false, rule: 'email', message: "Ne donnez pas votre adresse e-mail en public. Utilisez le message privé si vous le souhaitez." };
    }
    if (RE_TEL.test(text.replace(/\s+/g, ' '))) {
      return { ok: false, rule: 'phone', message: "Ne donnez pas de numéro de téléphone en public." };
    }
    if (RE_RESEAU.test(text)) {
      return { ok: false, rule: 'social', message: "Le partage de comptes Snapchat, Telegram ou WhatsApp n'est pas autorisé ici." };
    }
  }

  if (!opts.skipLinks && config.moderation.blockLinks && RE_LIEN.test(text)) {
    const autorise = config.moderation.linkWhitelist.some((d) => text.toLowerCase().includes(d));
    if (!autorise) {
      return { ok: false, rule: 'link', message: "Les liens ne sont pas autorisés dans le tchat." };
    }
  }

  const hits = matchWords(text);
  const bloquant = hits.find((h) => h.action === 'block');
  if (bloquant) {
    return { ok: false, rule: 'word:' + bloquant.word, message: "Ce message ne respecte pas les règles du tchat." };
  }
  if (hits.length) text = maskWords(text, hits);

  return { ok: true, text, masked: hits.length > 0 };
}

/* Empreinte d'IP : on ne stocke jamais l'adresse en clair. Elle suffit à
   reconnaître un banni, elle ne permet pas de remonter à la personne. */
function hashIp(ip) {
  return crypto.createHmac('sha256', config.secret || 'chatnow').update(String(ip || '')).digest('hex');
}

async function logRefus(pseudo, ipHash, rule, body) {
  try {
    await db.run(
      'INSERT INTO moderation_log (pseudo, ip_hash, rule, body, created_at) VALUES (?,?,?,?,NOW())',
      [String(pseudo).slice(0, 24), ipHash || null, String(rule).slice(0, 40), String(body || '').slice(0, 1000)]
    );
  } catch (e) { /* le journal ne doit jamais empêcher le tchat de fonctionner */ }
}

async function isBanned({ ipHash, pseudo }) {
  const row = await db.one(
    `SELECT scope, reason, expires_at FROM bans
      WHERE ((scope='ip' AND value=?) OR (scope='pseudo' AND value=?))
        AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
    [ipHash || '', String(pseudo || '').toLowerCase()]
  );
  return row || null;
}

module.exports = {
  normalise, colle, reloadWords, matchWords, maskWords,
  checkMessage, floodCheck, forgetFlood, hashIp, logRefus, isBanned,
};
