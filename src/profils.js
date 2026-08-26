'use strict';
/* Profils affichés dans la liste des connectés.
 *
 * Une seule définition, côté serveur, exposée au navigateur par /api/profils :
 * si la couleur du « Couple » était écrite à deux endroits, elle finirait par
 * différer entre le formulaire d'entrée et la liste des connectés.
 *
 * La clé est stockée en base dans visitors.gender — une colonne texte, pas un
 * ENUM : ajouter un profil ici suffit, aucune migration n'est nécessaire.
 */
const PROFILS = [
  { cle: 'h',         nom: 'Homme',        court: 'Homme',     couleur: '#3b82f6' },
  { cle: 'f',         nom: 'Femme',        court: 'Femme',     couleur: '#ec4899' },
  { cle: 'couple',    nom: 'Couple',       court: 'Couple',    couleur: '#f59e0b' },
  { cle: 'gay',       nom: 'Gay',          court: 'Gay',       couleur: '#a855f7' },
  { cle: 'lesbienne', nom: 'Lesbienne',    court: 'Lesbienne', couleur: '#d946ef' },
  { cle: 'trans',     nom: 'Trans',        court: 'Trans',     couleur: '#14b8a6' },
  { cle: 'a',         nom: 'Je préfère ne pas dire', court: '', couleur: '#94a3b8' },
];

const parCle = Object.fromEntries(PROFILS.map((p) => [p.cle, p]));

const valide = (cle) => Object.prototype.hasOwnProperty.call(parCle, String(cle));
const couleur = (cle) => (parCle[String(cle)] || parCle.a).couleur;
const nom = (cle) => (parCle[String(cle)] || parCle.a).court;

module.exports = { PROFILS, parCle, valide, couleur, nom };
