'use strict';
/* Contrôles du filtre de contenu.
 *
 * Les cas « doivent PASSER » comptent autant que les cas « doivent être
 * bloqués » : un filtre trop large refuse des phrases normales, et le visiteur
 * qui se fait refuser un message anodin ne revient pas. On teste donc les deux
 * côtés, et la liste des faux positifs est délibérément piégeuse.
 *
 * Ce fichier n'a besoin d'aucune base de données : on injecte la liste de mots
 * directement. Lancement :  node test/moderation.test.js
 */
process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-test-secret-32-chars!';

const assert = require('assert');
const Module = require('module');

/* La liste de mots vient normalement de MySQL. On remplace le module de base
   de données par un faux avant de charger la modération, ce qui évite de
   dépendre d'un serveur pour tester une fonction purement locale. */
const vraiRequire = Module.prototype.require;
Module.prototype.require = function (chemin) {
  if (chemin === './db') {
    return {
      query: async () => ([
        { word: 'connard', action: 'mask' },
        { word: 'salope', action: 'mask' },
        { word: 'pd', action: 'mask' },
        { word: 'nègre', action: 'block' },
        { word: 'pédophile', action: 'block' },
        { word: 'snap sexe', action: 'block' },
      ]),
      run: async () => ({}),
      one: async () => null,
    };
  }
  return vraiRequire.apply(this, arguments);
};

const mod = require('../src/moderation');

let ok = 0;
const echecs = [];
const verifie = (titre, condition) => {
  if (condition) { ok++; return; }
  echecs.push(titre);
};

(async () => {
  await mod.reloadWords();

  /* ---------------- normalisation ---------------- */
  verifie('normalise : accents', mod.normalise('Pédophile') === 'pedophile');
  verifie('normalise : leet', mod.normalise('c0nn4rd') === 'conard');
  verifie('normalise : répétitions', mod.normalise('coooonnnnard') === 'conard');
  verifie('colle : séparateurs', mod.colle('c-o-n-n-a-r-d') === 'conard');

  /* ---------------- doivent être ATTRAPÉS ---------------- */
  const attrapes = [
    ['insulte simple', 'espèce de connard'],
    ['insulte déguisée en chiffres', 'espèce de c0nn4rd'],
    ['insulte espacée', 'espèce de c o n n a r d'],
    ['insulte avec points', 'c.o.n.n.a.r.d'],
    ['insulte répétée', 'coooonnard va'],
    ['insulte majuscules', 'SALOPE'],
    ['insulte accentuée', 'sàlope'],
    ['mot court entre ponctuation', 'sale pd !'],
  ];
  for (const [titre, texte] of attrapes) {
    verifie('attrape — ' + titre + ' : ' + texte, mod.matchWords(texte).length > 0);
  }

  /* ---------------- ne doivent PAS être attrapés ---------------- *
   * Chacun contient les lettres d'un mot filtré, ou s'en approche.  */
  const innocents = [
    ['rapide', 'je réponds rapidement'],          // contient p…d
    ['pédale', 'je fais du vélo, je pédale'],
    ['salopette', 'il porte une salopette bleue'],
    ['connaissance', 'ravi de faire ta connaissance'],
    ['connard absent', 'je connais ce cinéma'],
    ['negro (mot italien courant ?)', 'le café noir'],
    ['phrase banale', 'salut ça va ? tu viens d\'où ?'],
    ['pd dans un mot', 'le fichier est en pdf'],
    ['upload', 'je vais upload la photo'],
    ['expédier', 'je vais expédier le colis demain'],
  ];
  for (const [titre, texte] of innocents) {
    const hits = mod.matchWords(texte);
    verifie('laisse passer — ' + titre + ' : ' + texte + (hits.length ? ' (bloqué par : ' + hits.map((h) => h.word).join(',') + ')' : ''), hits.length === 0);
  }

  /* ---------------- message complet ---------------- */
  const bloques = [
    ['mot en refus', 'sale nègre', 'word:nègre'],
    ['lien', 'viens sur http://exemple-arnaque.com', 'link'],
    ['lien sans protocole', 'va voir exemple.com', 'link'],
    ['e-mail', 'écris-moi à jean@exemple.fr', 'email'],
    ['téléphone', 'appelle moi au 06 12 34 56 78', 'phone'],
    ['téléphone collé', 'mon num 0612345678', 'phone'],
    ['snap', 'ajoute mon snap : jeanjean75', 'social'],
    ['telegram', 'telegram = @moncompte', 'social'],
    ['message vide', '   ', 'empty'],
    ['message trop long', 'a'.repeat(600), 'length'],
  ];
  for (const [titre, texte, regle] of bloques) {
    const r = mod.checkMessage(texte);
    verifie('refuse — ' + titre + ' (attendu ' + regle + ', obtenu ' + (r.rule || 'accepté') + ')',
      !r.ok && r.rule === regle);
  }

  const acceptes = [
    ['bonjour', 'Bonjour tout le monde, comment allez-vous ?'],
    ['question', 'Quelqu\'un de Lyon ici ?'],
    ['emoji', 'Salut 😀 ça va bien ?'],
    ['chiffres normaux', 'j\'ai 34 ans et 2 enfants'],
    ['heure', 'on se parle vers 18h30 ?'],
    ['date', 'je pars le 12/05/2027'],
    ['prix', 'ça coûte 1500 euros'],
  ];
  for (const [titre, texte] of acceptes) {
    const r = mod.checkMessage(texte);
    verifie('accepte — ' + titre + ' : ' + texte + (r.ok ? '' : ' (refusé pour ' + r.rule + ')'), r.ok);
  }

  /* ---------------- masquage ---------------- */
  const m = mod.checkMessage('tu es un connard');
  verifie('masque le mot', m.ok && m.masked && m.text.indexOf('connard') < 0 && m.text.indexOf('c*') >= 0);

  /* ---------------- majuscules ---------------- */
  const cri = mod.checkMessage('BONJOUR TOUT LE MONDE COMMENT ALLEZ VOUS');
  verifie('remet les cris en minuscules', cri.ok && cri.text === 'Bonjour tout le monde comment allez vous');
  const courtMaj = mod.checkMessage('OUI');
  verifie('laisse les mots courts en majuscules', courtMaj.ok && courtMaj.text === 'OUI');

  /* ---------------- anti-flood ---------------- */
  for (let i = 0; i < 5; i++) mod.floodCheck('u1', 'message ' + i);
  const trop = mod.floodCheck('u1', 'message 6');
  verifie('anti-flood : bloque au 6e message', !trop.ok && trop.rule === 'flood');
  const autre = mod.floodCheck('u2', 'coucou');
  verifie('anti-flood : n\'affecte pas un autre visiteur', autre.ok);
  mod.floodCheck('u3', 'bonjour');
  const repet = mod.floodCheck('u3', 'bonjour');
  verifie('anti-flood : refuse le message identique', !repet.ok && repet.rule === 'repeat');

  /* ---------------- empreinte d'IP ---------------- */
  const h1 = mod.hashIp('81.250.10.4');
  verifie('empreinte IP : stable', h1 === mod.hashIp('81.250.10.4'));
  verifie('empreinte IP : différente pour une autre IP', h1 !== mod.hashIp('81.250.10.5'));
  verifie('empreinte IP : ne contient pas l\'adresse', h1.indexOf('81.250') < 0 && /^[a-f0-9]{64}$/.test(h1));

  /* ---------------- résultat ---------------- */
  console.log('\n' + ok + ' contrôles passés, ' + echecs.length + ' échec(s).');
  if (echecs.length) {
    echecs.forEach((e) => console.log('  ✗ ' + e));
    process.exit(1);
  }
  console.log('Filtre de contenu : tout est conforme.\n');
  assert.ok(true);
})();
