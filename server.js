'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./src/config');
const db = require('./src/db');
const mod = require('./src/moderation');
const sockets = require('./src/sockets');
const session = require('./src/session');
const routes = require('./src/routes');

/* Une clé de signature absente ne « dégrade » pas le service, elle le rend
   contrefaisable : n'importe qui fabriquerait un cookie de modérateur. On
   refuse donc de démarrer plutôt que de tourner en apparence normalement. */
if (!config.secret || config.secret.length < 16) {
  console.error("APP_SECRET manquant ou trop court (32 caractères conseillés). Voir .env.example.");
  process.exit(1);
}

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  /* index.html doit rester frais : c'est là que le visiteur entre son pseudo,
     une version en cache renverrait vers un salon qui n'existe plus. */
  setHeaders: (res, f) => { if (f.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.use(routes);

app.get('/chat', (req, res) => {
  if (!session.readSession(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/sante', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, online: require('./src/presence').online() });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), (err) => {
    if (err) res.status(404).type('text/plain').send('Page introuvable.');
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  /* Le repli « polling » sert aux réseaux d'entreprise et à certains proxys
     qui coupent les WebSocket : sans lui, le tchat ne s'ouvre pas du tout
     pour ces visiteurs-là. */
  transports: ['websocket', 'polling'],
  pingTimeout: 25000,
  maxHttpBufferSize: 1e5,
});

(async () => {
  try {
    await db.migrate();
    const n = await mod.reloadWords();
    sockets.attach(io);

    server.listen(config.port, () => {
      console.log(`${config.siteName} écoute sur le port ${config.port} — ${n} mots filtrés chargés.`);
    });

    /* Purge RGPD : une fois au démarrage puis toutes les six heures. */
    const purge = async () => {
      try {
        const r = await db.purge();
        const total = Object.values(r).reduce((a, b) => a + b, 0);
        if (total) console.log('Purge :', JSON.stringify(r));
      } catch (e) { console.error('Purge impossible :', e.message); }
    };
    purge();
    setInterval(purge, 6 * 3600 * 1000).unref();
  } catch (e) {
    console.error('Démarrage impossible :', e.message);
    process.exit(1);
  }
})();

/* Arrêt propre : on prévient les navigateurs connectés, sinon ils affichent
   « connexion perdue » alors que c'est un simple redémarrage. */
const stop = () => {
  io.emit('server:restart');
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
