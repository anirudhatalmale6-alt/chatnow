/* ------------------------------------------------------------------ *
 * Thèmes de couleurs — partagé par l'accueil et le tchat              *
 * ------------------------------------------------------------------ *
 * Le thème est appliqué sur <html> AVANT le rendu de la page (ce fichier
 * est chargé dans <head>) : appliqué plus tard, le visiteur verrait un
 * éclair blanc avant que le thème sombre ne se pose.
 */
(function (global) {
  'use strict';

  var THEMES = [
    { cle: 'clair',  nom: 'Clair',   pastille: '#2563eb', sombre: false },
    { cle: 'sombre', nom: 'Sombre',  pastille: '#0b1220', sombre: true },
    { cle: 'violet', nom: 'Violet',  pastille: '#8b5cf6', sombre: true },
    { cle: 'ocean',  nom: 'Océan',   pastille: '#0ea5e9', sombre: true },
    { cle: 'rose',   nom: 'Rose',    pastille: '#ec4899', sombre: false },
    { cle: 'neon',   nom: 'Néon',    pastille: '#22d3ee', sombre: true },
  ];

  function actuel() {
    var t = null;
    try { t = localStorage.getItem('cn-theme'); } catch (e) { /* navigation privée */ }
    if (t && THEMES.some(function (x) { return x.cle === t; })) return t;
    /* Aucun choix enregistré : on suit le réglage du système d'exploitation,
       comme le fait n'importe quelle application moderne. */
    return (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'sombre' : 'clair';
  }

  function applique(cle) {
    document.documentElement.setAttribute('data-theme', cle);
    try { localStorage.setItem('cn-theme', cle); } catch (e) { /* sans importance */ }
  }

  /* Menu déroulant des thèmes, accroché à un bouton. */
  function menu(bouton) {
    if (!bouton) return;
    var pop = document.createElement('div');
    pop.className = 'theme-pop';
    pop.hidden = true;
    pop.innerHTML = THEMES.map(function (t) {
      return '<button type="button" data-t="' + t.cle + '">' +
        '<i style="background:' + t.pastille + '"></i>' + t.nom + '</button>';
    }).join('');
    document.body.appendChild(pop);

    /* Le menu doit être VISIBLE avant d'être placé : tant qu'il est masqué sa
       hauteur vaut zéro et on ne peut pas savoir s'il tient sous le bouton.
       Or ce bouton est en bas de la colonne : ouvert vers le bas, le menu
       sortait complètement de l'écran — présent dans la page, invisible pour
       le visiteur. Il s'ouvre donc vers le haut quand la place manque. */
    var place = function () {
      var r = bouton.getBoundingClientRect();
      var h = pop.offsetHeight || 220;
      var dessous = r.bottom + 6;
      pop.style.top = (dessous + h + 8 > global.innerHeight ? Math.max(8, r.top - h - 6) : dessous) + 'px';
      /* Aligné à droite du bouton, mais jamais hors de l'écran : sur un
         téléphone le bouton est parfois à 10 px du bord. */
      pop.style.left = Math.max(8, Math.min(r.right - 168, global.innerWidth - 176)) + 'px';
    };

    bouton.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!pop.hidden) { pop.hidden = true; return; }
      pop.hidden = false;
      place();
      marque();
    });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-t]') : null;
      if (!b) return;
      applique(b.getAttribute('data-t'));
      pop.hidden = true;
      icone(bouton);
      if (typeof global.onThemeChange === 'function') global.onThemeChange();
    });
    document.addEventListener('click', function (e) {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== bouton) pop.hidden = true;
    });
    global.addEventListener('resize', function () { if (!pop.hidden) place(); });

    function marque() {
      var a = document.documentElement.getAttribute('data-theme');
      [].forEach.call(pop.querySelectorAll('button'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-t') === a);
      });
    }
    icone(bouton);
  }

  function icone(bouton) {
    var a = document.documentElement.getAttribute('data-theme');
    var t = THEMES.filter(function (x) { return x.cle === a; })[0] || THEMES[0];
    bouton.innerHTML = '<i class="theme-dot" style="background:' + t.pastille + '"></i>';
    bouton.title = 'Thème : ' + t.nom;
  }

  applique(actuel());
  global.CNTheme = { THEMES: THEMES, applique: applique, actuel: actuel, menu: menu };
})(window);
