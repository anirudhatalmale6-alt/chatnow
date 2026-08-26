'use strict';
/* ------------------------------------------------------------------ *
 * Import des villes et codes postaux (GeoNames, CC BY 4.0)            *
 * ------------------------------------------------------------------ *
 *   node scripts/import-cities.js            → France seule
 *   node scripts/import-cities.js FR BE CH   → plusieurs pays
 *   node scripts/import-cities.js FR --fichier /chemin/FR.txt
 *
 * L'import est rejouable : relancé, il met à jour les lignes existantes au
 * lieu d'en créer des doublons. À faire une fois à l'installation, puis une
 * fois par an si vous voulez suivre les changements de communes.
 *
 * ATTENTION : la licence CC BY 4.0 impose de citer GeoNames. L'attribution
 * est déjà dans le pied de page du site — ne la retirez pas.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { execFileSync } = require('child_process');
const db = require('../src/db');
const geo = require('../src/geo');

const args = process.argv.slice(2);
const iFichier = args.indexOf('--fichier');
const fichierLocal = iFichier >= 0 ? args[iFichier + 1] : null;
/* `iFichier + 1` vaut 0 quand --fichier est absent : sans le test « >= 0 », le
   PREMIER pays de la ligne de commande était écarté en silence, et l'import
   « FR BE » n'importait que la Belgique. */
const pays = args
  .filter((a, i) => /^[A-Za-z]{2}$/.test(a) && !(iFichier >= 0 && i === iFichier + 1))
  .map((s) => s.toUpperCase());
if (!pays.length) pays.push('FR');

function telecharge(url, destination) {
  return new Promise((resolve, reject) => {
    const flux = fs.createWriteStream(destination);
    https.get(url, (rep) => {
      if (rep.statusCode >= 300 && rep.statusCode < 400 && rep.headers.location) {
        flux.close();
        return telecharge(rep.headers.location, destination).then(resolve, reject);
      }
      if (rep.statusCode !== 200) {
        flux.close();
        return reject(new Error('HTTP ' + rep.statusCode + ' sur ' + url));
      }
      rep.pipe(flux);
      flux.on('finish', () => flux.close(() => resolve(destination)));
    }).on('error', (e) => { flux.close(); reject(e); });
  });
}

/* Le fichier GeoNames est un ZIP. Node ne sait pas le lire seul et je refuse
   d'ajouter une dépendance pour une opération faite une fois par an : on
   appelle `unzip`, et on explique clairement quoi faire s'il manque. */
function extrait(zip, dossier, nom) {
  try {
    execFileSync('unzip', ['-o', '-q', zip, nom, '-d', dossier], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(
      "Impossible d'ouvrir l'archive : la commande `unzip` est absente.\n" +
      "  Debian/Ubuntu : apt install unzip\n" +
      "  Sinon, décompressez l'archive à la main puis relancez avec --fichier /chemin/" + nom
    );
  }
  return path.join(dossier, nom);
}

async function importe(code, chemin) {
  const lignes = fs.readFileSync(chemin, 'utf8').split('\n');
  const vues = new Set();
  let lot = [];
  let total = 0;
  let ignorees = 0;

  const vide = async () => {
    if (!lot.length) return;
    /* Un seul INSERT pour 500 lignes : ligne par ligne, l'import de 50 000
       communes prendrait plusieurs minutes au lieu de quelques secondes. */
    const valeurs = lot.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    await db.run(
      `INSERT INTO cities (country, postal, name, name_norm, dept, region, lat, lng)
       VALUES ${valeurs}
       ON DUPLICATE KEY UPDATE name_norm=VALUES(name_norm), dept=VALUES(dept),
                               region=VALUES(region), lat=VALUES(lat), lng=VALUES(lng)`,
      lot.flat()
    );
    total += lot.length;
    lot = [];
  };

  for (const ligne of lignes) {
    if (!ligne.trim()) continue;
    const c = ligne.split('\t');
    /* pays, code postal, commune, région, …, département, …, latitude, longitude */
    const [country, postal, name, region, , dept, , , , lat, lng] = c;
    if (!country || !postal || !name || !lat || !lng) { ignorees++; continue; }
    if (Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) { ignorees++; continue; }
    /* GeoNames contient aussi les codes CEDEX (« 75021 CEDEX 01 »), qui sont
       des boîtes postales d'entreprises. Personne ne les saisit comme code
       postal d'habitation, et ils feraient doublon dans la liste. */
    if (!geo.codePostalValide(postal.trim(), country)) { ignorees++; continue; }

    const cp = geo.normalisePostal(postal);
    const cle = country + '|' + cp + '|' + name;
    if (vues.has(cle)) continue;      // GeoNames répète certaines lignes
    vues.add(cle);

    lot.push([country, cp, name.trim(), geo.normalise(name),
      (dept || '').trim() || null, (region || '').trim() || null,
      Number(lat), Number(lng)]);
    if (lot.length >= 500) await vide();
  }
  await vide();
  return { total, ignorees };
}

(async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'geonames-'));
  try {
    await db.migrate();
    for (const code of pays) {
      let chemin = fichierLocal;
      if (!chemin) {
        const zip = path.join(dossier, code + '.zip');
        process.stdout.write(`${code} : téléchargement… `);
        await telecharge(`https://download.geonames.org/export/zip/${code}.zip`, zip);
        chemin = extrait(zip, dossier, code + '.txt');
        process.stdout.write('ok\n');
      }
      process.stdout.write(`${code} : import… `);
      const r = await importe(code, chemin);
      console.log(`${r.total} communes` + (r.ignorees ? ` (${r.ignorees} lignes ignorées : CEDEX ou données incomplètes)` : ''));
    }

    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM cities');
    console.log(`\nTable cities : ${n} lignes au total.`);

    /* Contrôle immédiat : un import qui ne sait pas retrouver Toulouse par son
       code postal n'a servi à rien, autant le savoir tout de suite. */
    const t = await geo.parCodePostal('31000', 'FR');
    const p = await geo.parCodePostal('75001', 'FR');
    if (t.length && p.length) {
      const d = geo.distanceKm(t[0].lat, t[0].lng, p[0].lat, p[0].lng);
      console.log(`Contrôle : 31000 = ${t[0].name}, 75001 = ${p[0].name}, distance ${Math.round(d)} km (attendu ~ 590 km).`);
    } else {
      console.log('Contrôle ÉCHOUÉ : 31000 ou 75001 introuvable. Vérifiez le fichier importé.');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error('\nImport impossible :', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
    await db.getPool().end();
  }
})();
