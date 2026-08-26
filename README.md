# ChatNow — tchat en ligne gratuit, instantané, sans inscription

Tchat web complet : salons de discussion, messages privés, modération
automatique et panneau d'administration. Node.js + WebSocket (socket.io) +
MySQL / MariaDB. Aucune publicité, aucun pisteur.

---

## Ce que le site fait

**Pour le visiteur**

- Entrée en un écran : pseudo, âge, sexe, région. Pas de compte, pas de mot de passe.
- Salons thématiques, avec le nombre de personnes connectées en direct.
- Messages instantanés (WebSocket, aucun rechargement de page).
- Messages privés, en onglets, avec compteur de messages non lus.
- Liste des connectés ; un clic sur un pseudo ouvre sa fiche : message privé, ignorer, signaler.
- « X est en train d'écrire… ».
- Sélecteur d'emojis.
- Ignorer quelqu'un : ses messages disparaissent, en salon comme en privé.
- Signaler un message en un clic ; le signalement part directement à la modération.
- Bandeau « connexion perdue / reconnexion en cours », et reprise automatique du salon.
- Thème clair et thème sombre.
- Interface téléphone complète : salons et connectés en tiroirs latéraux.
- **Code postal → ville** : la commune est reconnue automatiquement (France, Belgique,
  Suisse, Luxembourg, Monaco). Un code partagé par plusieurs communes les propose toutes.
- **Distance en kilomètres** entre soi et chaque personne, et liste classée du plus proche
  au plus loin. Soi-même en tête, marqué « vous ».
- **Profils colorés** : Homme, Femme, Couple, Gay, Lesbienne, Trans — chacun sa couleur,
  reprise sur l'avatar et dans la liste.
- **Six thèmes** : Clair, Sombre, Violet, Océan, Rose, Néon. Le choix est retenu.
- **Salons micro** : on se parle à la voix. Le son va directement d'un navigateur à
  l'autre (WebRTC), il ne passe pas par le serveur.
- **Salons radio** : tout le monde écoute le même flux et en discute.

**Pour l'administrateur** (`/admin`)

- Tableau de bord : connectés, messages, signalements en attente, messages refusés, bannissements.
- Salons : créer, renommer, masquer, ordonner, fixer un âge minimum, choisir le type
  (texte, micro, radio) et l'adresse du flux radio.
- Mots filtrés : masquer le mot ou refuser tout le message.
- Signalements : bannir ou classer sans suite.
- Bannissements : par pseudo ou par empreinte d'adresse IP, temporaires ou définitifs.
- Journal des messages refusés — sert à régler la liste sans deviner.

**Modération automatique**

- Filtre d'insultes qui reconnaît les déguisements : `c0nn4rd`, `c-o-n-n-a-r-d`, `cooonnard`.
- Anti-flood : 5 messages / 10 s, puis 30 s de pause ; message identique refusé.
- Liens bloqués (liste blanche possible).
- E-mails, numéros de téléphone et comptes Snapchat / Telegram / WhatsApp bloqués en public.
- Messages entièrement en majuscules remis en minuscules.
- Pseudos réservés (`admin`, `moderateur`…) et pseudos injurieux refusés.
- Salons réservés aux majeurs, contrôlés côté serveur.

**Vie privée (CNIL / RGPD)**

- Un seul cookie, strictement nécessaire au service : pas de bandeau de consentement.
- L'adresse IP n'est jamais stockée en clair, seulement une empreinte irréversible.
- Purge automatique des messages, des journaux et des sessions inactives au bout de 30 jours.
- Aucune publicité, aucun pisteur, aucun appel à un service tiers.

---

## Installation

Prérequis : Node.js 18 ou plus récent, et un MySQL 5.7+ / MariaDB 10.3+.

```bash
git clone <dépôt> chatnow
cd chatnow
npm install --omit=dev
cp .env.example .env
```

Créer la base :

```sql
CREATE DATABASE chatnow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'chat'@'localhost' IDENTIFIED BY 'un-mot-de-passe-solide';
GRANT ALL ON chatnow.* TO 'chat'@'localhost';
```

Remplir `.env`. Deux valeurs sont obligatoires :

```
APP_SECRET=      # openssl rand -hex 32
ADMIN_PASSWORD=  # mot de passe du panneau /admin
```

Le serveur refuse de démarrer sans `APP_SECRET` : sans elle, n'importe qui
pourrait fabriquer un cookie de modérateur.

Les tables et les salons de départ sont créés automatiquement au premier
démarrage — aucun fichier SQL à importer à la main.

Importer les villes et codes postaux (une fois) :

```bash
node scripts/import-cities.js FR          # France seule
node scripts/import-cities.js FR BE CH LU MC
```

Environ 49 000 communes pour ces cinq pays. Le script se termine par un contrôle
(31000 doit donner Toulouse, et Toulouse–Paris ≈ 590 km) : s'il échoue, l'import
n'a rien donné d'exploitable. Sans cet import le tchat fonctionne, mais sans
ville reconnue ni distance.

Les données viennent de **GeoNames**, sous licence **CC BY 4.0** : l'attribution
dans le pied de page est une obligation légale, ne la retirez pas.

```bash
npm start
```

## Mise en service

Derrière un serveur web (Nginx, OpenLiteSpeed, Apache), mettre `TRUST_PROXY=1`
dans `.env` — sinon toutes les connexions paraissent venir de la même adresse
et un seul bannissement met tout le monde dehors.

Le WebSocket doit être transmis. Exemple Nginx :

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

Pour que le service redémarre tout seul :

```bash
npm install -g pm2
pm2 start server.js --name chatnow
pm2 save && pm2 startup
```

## Contrôles

```bash
npm test                 # 48 contrôles du filtre de contenu, sans base de données
python3 test/e2e.py      # 45 contrôles : salons, privé, modération, mobile, admin
python3 test/e2e2.py     # 46 contrôles : code postal, distances, profils, thèmes,
                         #                radio, et un VRAI appel audio WebRTC
```

Le parcours audio utilise les faux périphériques de Chromium
(`--use-fake-device-for-media-stream`) : l'appel établi est un véritable appel
WebRTC entre deux navigateurs, on vérifie qu'une piste audio arrive et qu'elle
est active.

Le parcours navigateur vérifie chaque étape **dans l'autre fenêtre** : qu'un
message s'affiche chez celui qui l'écrit ne prouve pas qu'il soit parti.

## Réglages utiles (`.env`)

| Variable | Rôle | Défaut |
|---|---|---|
| `FLOOD_MAX_MESSAGES` | messages autorisés par fenêtre | `5` |
| `FLOOD_WINDOW_MS` | durée de la fenêtre | `10000` |
| `FLOOD_MUTE_SECONDS` | pause imposée ensuite | `30` |
| `BLOCK_LINKS` | bloquer les liens en public | `1` |
| `LINK_WHITELIST` | domaines tolérés, séparés par des virgules | vide |
| `BLOCK_CONTACT_DETAILS` | bloquer e-mails, numéros et réseaux | `1` |
| `MIN_AGE` | âge minimum pour entrer | `15` |
| `RETENTION_DAYS` | durée de conservation des messages | `30` |
| `VOICE_MAX_SPEAKERS` | personnes au micro en même temps | `8` |
| `ICE_SERVERS` | serveurs STUN/TURN pour le micro | STUN Google |
| `HISTORY_MESSAGES` | messages affichés à l'entrée dans un salon | `50` |

## Organisation du code

```
server.js              démarrage, sécurité des en-têtes, purge périodique
src/config.js          tous les réglages, lus dans .env
src/db.js              connexions, création du schéma, salons par défaut, purge RGPD
src/schema.sql         tables (rejouable sans risque)
src/moderation.js      filtre de contenu, anti-flood, bannissements, empreinte d'IP
src/session.js         cookie de session signé
src/presence.js        qui est connecté et dans quel salon (en mémoire)
src/sockets.js         tous les échanges temps réel
src/geo.js             villes, codes postaux, distances
src/profils.js         profils affichés et leurs couleurs (source unique)
src/routes.js          API d'entrée + panneau d'administration
scripts/import-cities.js  import GeoNames des communes
public/                interface (aucune dépendance externe, aucune police distante)
public/js/theme.js     les six palettes, appliquées avant le rendu
public/js/voix.js      salons micro : connexion audio directe entre navigateurs
test/                  contrôles du filtre + parcours navigateur
```


## Le micro : ce qu'il faut savoir avant la mise en ligne

1. **https est obligatoire.** Les navigateurs n'autorisent le micro que sur une
   adresse en `https://` (ou `localhost` en développement). Sur une adresse IP
   en `http://`, Chrome refuse **sans afficher d'explication**. Ce n'est pas un
   réglage du site, c'est une règle du navigateur.
2. **Le son ne passe pas par le serveur.** Chaque personne au micro envoie son
   flux directement à toutes les autres. Le serveur ne transmet que quelques
   messages de mise en relation, il ne coûte donc presque rien — mais le nombre
   de micros simultanés doit rester limité (`VOICE_MAX_SPEAKERS`).
3. **Un serveur TURN peut être nécessaire.** Derrière certains réseaux très
   fermés, deux navigateurs n'arrivent pas à se joindre directement. Il faut
   alors un serveur TURN (coturn), qui relaie le son — et qui consomme, lui, de
   la bande passante.
4. **Une salle vidéo, ce n'est pas la même chose.** À quelques personnes, la
   même technique suffit. À plusieurs dizaines de caméras, il faut un serveur de
   distribution vidéo dédié, et une machine bien plus puissante.
