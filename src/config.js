'use strict';
/* Configuration centrale. Tout se règle par variables d'environnement (.env)
   pour qu'aucun mot de passe ne se retrouve jamais dans le dépôt Git. */
require('dotenv').config();

const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|oui|yes|on)$/i.test(String(v)));
const int = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : parseInt(v, 10));

const config = {
  port: int(process.env.PORT, 3000),
  /* Derrière Nginx / OpenLiteSpeed, l'adresse IP réelle arrive dans
     X-Forwarded-For. Sans ce réglage, tout le monde partagerait la même IP et
     un seul bannissement mettrait dehors l'ensemble des visiteurs. */
  trustProxy: bool(process.env.TRUST_PROXY, false),
  siteName: process.env.SITE_NAME || 'ChatNow',
  siteUrl: (process.env.SITE_URL || '').replace(/\/+$/, ''),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'chat',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chatnow',
    connectionLimit: int(process.env.DB_POOL, 10),
  },

  /* Clé de signature des cookies de session. Obligatoire en production :
     sans elle, n'importe qui pourrait fabriquer un cookie et se faire passer
     pour un modérateur. Le serveur refuse de démarrer si elle manque. */
  secret: process.env.APP_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  /* Durée de vie de la session visiteur (il garde son pseudo s'il ferme
     l'onglet et revient). Cookie strictement nécessaire au service : pas de
     bandeau de consentement à afficher (recommandation CNIL). */
  sessionDays: int(process.env.SESSION_DAYS, 7),

  moderation: {
    maxMessageLength: int(process.env.MAX_MESSAGE_LENGTH, 500),
    floodWindowMs: int(process.env.FLOOD_WINDOW_MS, 10000),
    floodMaxMessages: int(process.env.FLOOD_MAX_MESSAGES, 5),
    floodMuteSeconds: int(process.env.FLOOD_MUTE_SECONDS, 30),
    /* Les liens sont le premier vecteur de spam sur un tchat anonyme. */
    blockLinks: bool(process.env.BLOCK_LINKS, true),
    linkWhitelist: (process.env.LINK_WHITELIST || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    /* Protège les mineurs : pas de numéro ni d'e-mail en public. */
    blockContactDetails: bool(process.env.BLOCK_CONTACT_DETAILS, true),
    minAge: int(process.env.MIN_AGE, 15),
    maxAge: int(process.env.MAX_AGE, 99),
  },

  /* Salons audio. Le son circule directement entre les navigateurs : chaque
     personne au micro envoie son flux à toutes les autres. Au-delà d'une
     dizaine, la connexion des participants sature bien avant le serveur —
     d'où cette limite, réglable mais volontairement basse. */
  voiceMaxSpeakers: int(process.env.VOICE_MAX_SPEAKERS, 8),
  /* Serveurs STUN : ils servent à découvrir son adresse publique pour que
     deux navigateurs derrière des box puissent se joindre. Aucune donnée ni
     aucun son n'y transite. Certains réseaux d'entreprise exigent en plus un
     serveur TURN — voir le README. */
  iceServers: (process.env.ICE_SERVERS || 'stun:stun.l.google.com:19302')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((url) => (url.startsWith('turn') && process.env.TURN_USER
      ? { urls: url, username: process.env.TURN_USER, credential: process.env.TURN_PASSWORD || '' }
      : { urls: url })),

  /* RGPD : les messages ne sont pas conservés indéfiniment. */
  retentionDays: int(process.env.RETENTION_DAYS, 30),
  historyMessages: int(process.env.HISTORY_MESSAGES, 50),
};

module.exports = config;
