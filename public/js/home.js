/* Page d'accueil : liste des salons en direct, choix du thème, formulaire
   d'entrée avec reconnaissance de la ville par le code postal. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  if (window.CNTheme) window.CNTheme.menu($('theme'));

  /* ----------------------------- salons ----------------------------- */
  var boite = $('rooms');
  function chargerSalons() {
    fetch('/api/rooms').then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return;
      $('online').textContent = d.online;
      boite.innerHTML = d.rooms.map(function (r) {
        var icone = r.kind === 'audio' ? '🎙️' : (r.kind === 'radio' ? '📻' : (r.emoji || '💬'));
        return '<div class="room-card"><span class="em">' + esc(icone) + '</span>' +
          '<span><b>' + esc(r.name) + '</b><small>' + esc(r.description || '') + '</small></span>' +
          '<span class="n">' + r.users + '</span></div>';
      }).join('');
    }).catch(function () { boite.innerHTML = '<p class="muted">Salons momentanément indisponibles.</p>'; });
  }
  chargerSalons();
  setInterval(chargerSalons, 20000);

  /* ----------------------------- profils ---------------------------- */
  fetch('/api/profils').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.ok) return;
    var sel = $('gender');
    sel.innerHTML = d.profils.map(function (p) {
      return '<option value="' + esc(p.cle) + '"' + (p.cle === 'a' ? ' selected' : '') + '>' + esc(p.nom) + '</option>';
    }).join('');
    var memo = localStorage.getItem('cn-gender');
    if (memo && sel.querySelector('option[value="' + memo.replace(/"/g, '') + '"]')) sel.value = memo;
  }).catch(function () {
    /* Sans la liste, le formulaire doit rester utilisable : on remet le
       minimum plutôt que de laisser un menu vide et un envoi impossible. */
    $('gender').innerHTML = '<option value="a">Je préfère ne pas dire</option>' +
      '<option value="h">Homme</option><option value="f">Femme</option>';
  });

  /* -------------------- code postal → ville ------------------------- */
  var cp = $('postal');
  var ville = $('city');
  var indice = $('cityHint');
  var enCours = 0;

  function majVilles() {
    var code = cp.value.trim();
    var pays = $('country').value;
    if (code.length < 4) {
      ville.innerHTML = '<option value="">Saisissez votre code postal</option>';
      ville.disabled = true;
      indice.className = 'hint';
      indice.textContent = 'La ville est trouvée automatiquement. Elle sert à vous proposer les personnes les plus proches.';
      return;
    }
    var ticket = ++enCours;
    fetch('/api/villes?cp=' + encodeURIComponent(code) + '&pays=' + encodeURIComponent(pays))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        /* Deux frappes rapides lancent deux requêtes ; la première peut
           revenir en dernier et écraser le bon résultat. On n'accepte que la
           réponse de la dernière demande. */
        if (ticket !== enCours) return;
        var v = (d && d.villes) || [];
        if (!v.length) {
          ville.innerHTML = '<option value="">Code postal inconnu</option>';
          ville.disabled = true;
          indice.className = 'hint err';
          indice.textContent = 'Ce code postal n\'existe pas dans notre base. Vérifiez-le.';
          return;
        }
        ville.innerHTML = v.map(function (x) {
          return '<option value="' + esc(x.nom) + '">' + esc(x.nom) + (x.dept ? ' (' + esc(x.dept) + ')' : '') + '</option>';
        }).join('');
        ville.disabled = false;
        indice.className = 'hint';
        indice.textContent = v.length > 1
          ? v.length + ' communes portent ce code postal, choisissez la vôtre.'
          : 'Ville reconnue : ' + v[0].nom + '.';
      })
      .catch(function () { if (ticket === enCours) indice.textContent = 'Recherche impossible pour le moment.'; });
  }

  var minuterie = null;
  cp.addEventListener('input', function () {
    clearTimeout(minuterie);
    minuterie = setTimeout(majVilles, 250);
  });
  $('country').addEventListener('change', majVilles);

  /* --------------------------- entrée ------------------------------- */
  var form = $('entry');
  var err = $('err');

  ['pseudo', 'age', 'postal'].forEach(function (id) {
    var v = localStorage.getItem('cn-' + id);
    if (v) $(id).value = v;
  });
  var paysMemo = localStorage.getItem('cn-country');
  if (paysMemo) $('country').value = paysMemo;
  if (cp.value) majVilles();

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.hidden = true;
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    var data = {
      pseudo: $('pseudo').value,
      age: $('age').value,
      gender: $('gender').value,
      country: $('country').value,
      postal: cp.value,
      city: ville.disabled ? '' : ville.value,
    };
    fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        localStorage.setItem('cn-pseudo', data.pseudo);
        localStorage.setItem('cn-age', data.age);
        localStorage.setItem('cn-gender', data.gender);
        localStorage.setItem('cn-country', data.country);
        localStorage.setItem('cn-postal', data.postal);
        location.href = d.redirect || '/chat';
        return;
      }
      err.textContent = d.message || 'Entrée impossible.';
      err.hidden = false;
      btn.disabled = false;
    }).catch(function () {
      err.textContent = 'Connexion au serveur impossible. Réessayez dans un instant.';
      err.hidden = false;
      btn.disabled = false;
    });
  });
})();
