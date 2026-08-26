'use strict';
const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'cn_sid';

const sign = (uid) =>
  uid + '.' + crypto.createHmac('sha256', config.secret).update(uid).digest('base64url');

/* Comparaison à temps constant : une comparaison classique s'arrête au premier
   caractère différent et laisse deviner la signature octet par octet. */
function verify(value) {
  if (typeof value !== 'string' || !value.includes('.')) return null;
  const i = value.lastIndexOf('.');
  const uid = value.slice(0, i);
  const sig = value.slice(i + 1);
  if (!/^[a-f0-9]{32}$/.test(uid)) return null;
  const attendu = crypto.createHmac('sha256', config.secret).update(uid).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(attendu);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return uid;
}

const newUid = () => crypto.randomBytes(16).toString('hex');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  return raw ? verify(raw) : null;
}

function setSession(res, uid, secure) {
  const maxAge = config.sessionDays * 86400;
  /* Cookie strictement nécessaire au fonctionnement du service : il ne sert
     qu'à retrouver le pseudo du visiteur, il ne suit personne et il ne part
     chez aucun tiers. C'est le cas prévu par la CNIL comme dispensé de
     consentement — donc pas de bandeau à afficher. */
  const parts = [
    `${COOKIE}=${encodeURIComponent(sign(uid))}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
  ];
  /* Secure sur une adresse en http:// (une IP nue, un test local) fait
     silencieusement JETER le cookie par le navigateur : la session semble
     expirer immédiatement sans le moindre message d'erreur. */
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { COOKIE, sign, verify, newUid, parseCookies, readSession, setSession, clearSession };
