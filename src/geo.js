'use strict';
/* ------------------------------------------------------------------ *
 * Villes, codes postaux et distances                                  *
 * ------------------------------------------------------------------ *
 * Les données viennent de GeoNames (licence CC BY 4.0 : l'attribution
 * est obligatoire, elle figure dans le pied de page du site). Elles
 * sont importées une fois dans la table `cities` — aucune API n'est
 * appelée pendant que le visiteur tape, donc aucune dépendance à un
 * service extérieur qui pourrait tomber ou devenir payant.
 *
 * Le point d'une ville est le CENTRE de la commune, jamais l'adresse de
 * la personne : la distance affichée reste volontairement approximative.
 */
const db = require('./db');

const RE_CP = {
  FR: /^[0-9]{5}$/,
  BE: /^[1-9][0-9]{3}$/,
  CH: /^[1-9][0-9]{3}$/,
  /* Le Luxembourg s'écrit avec le préfixe pays dans les données GeoNames
     (« L-4968 »), mais les habitants tapent les quatre chiffres seuls : les
     deux formes doivent être acceptées. */
  LU: /^(L-)?[0-9]{4}$/,
  MC: /^980[0-9]{2}$/,
};

const normalise = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/* Forme unique du code postal, appliquée À L'IMPORT ET À LA RECHERCHE. Sans
   cela, le Luxembourg est stocké « L-4968 » et cherché « 4968 » : la table est
   pleine et pourtant aucune commune n'est trouvée. */
const normalisePostal = (cp) => String(cp || '')
  .trim().toUpperCase().replace(/\s+/g, '').replace(/^[A-Z]{1,2}-/, '');

/* Un code postal peut couvrir plusieurs communes (et l'inverse). On renvoie
   donc toujours une liste, et c'est le visiteur qui choisit sa commune. */
async function parCodePostal(cp, pays) {
  const code = normalisePostal(cp);
  if (!code) return [];
  const params = [code];
  let sql = 'SELECT country, postal, name, dept, region, lat, lng FROM cities WHERE postal = ?';
  if (pays) { sql += ' AND country = ?'; params.push(String(pays).toUpperCase()); }
  sql += ' ORDER BY name LIMIT 40';
  return db.query(sql, params);
}

/* Recherche par début de nom : « toul » propose Toulouse, Toulon, Toul…
   Le classement met d'abord ce qui commence par la saisie, ensuite ce qui la
   contient — sinon « Paris » arriverait après « Cormeilles-en-Parisis ». */
async function parNom(q, limite = 12) {
  const n = normalise(q);
  if (n.length < 2) return [];
  const like = n.replace(/[%_]/g, '') + '%';
  const contient = '%' + n.replace(/[%_]/g, '') + '%';
  return db.query(
    `SELECT country, postal, name, dept, region, lat, lng,
            (name_norm LIKE ?) AS debut
       FROM cities
      WHERE name_norm LIKE ?
      ORDER BY debut DESC, CHAR_LENGTH(name), name, postal
      LIMIT ${Math.max(1, Math.min(40, parseInt(limite, 10) || 12))}`,
    [like, contient]
  );
}

async function ville(pays, cp, nom) {
  return db.one(
    'SELECT country, postal, name, dept, region, lat, lng FROM cities WHERE country = ? AND postal = ? AND name = ? LIMIT 1',
    [String(pays || 'FR').toUpperCase(), String(cp || ''), String(nom || '')]
  );
}

/* Distance à vol d'oiseau (formule de haversine), en kilomètres. */
function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || Number.isNaN(Number(v)))) return null;
  const R = 6371;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* Affichage volontairement arrondi. Deux personnes de la même commune
   partagent le même point : leur distance est 0, ce qui ne veut pas dire
   « à la même adresse ». « moins d'1 km » est la formulation honnête. */
function distanceTexte(km) {
  if (km === null || km === undefined) return '';
  if (km < 1) return "moins d'1 km";
  if (km < 10) return Math.round(km) + ' km';
  if (km < 100) return Math.round(km / 5) * 5 + ' km';
  return Math.round(km / 10) * 10 + ' km';
}

const codePostalValide = (cp, pays) => {
  const re = RE_CP[String(pays || 'FR').toUpperCase()];
  return re ? re.test(String(cp || '').trim()) : /^[A-Z0-9 -]{2,10}$/i.test(String(cp || '').trim());
};

module.exports = { parCodePostal, parNom, ville, distanceKm, distanceTexte, normalise, normalisePostal, codePostalValide, RE_CP };
