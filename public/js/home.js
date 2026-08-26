/* Page d'accueil : thème, liste des salons en direct, formulaire d'entrée. */
(function () {
  'use strict';

  /* --- thème --- */
  var root = document.documentElement;
  var pref = localStorage.getItem('cn-theme');
  if (pref) root.setAttribute('data-theme', pref);
  else if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) root.setAttribute('data-theme', 'dark');
  var majTheme = function () {
    var b = document.getElementById('theme');
    if (b) b.textContent = root.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  };
  majTheme();
  var bt = document.getElementById('theme');
  if (bt) bt.onclick = function () {
    var d = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', d);
    localStorage.setItem('cn-theme', d);
    majTheme();
  };

  /* --- salons --- */
  var boite = document.getElementById('rooms');
  function chargerSalons() {
    fetch('/api/rooms').then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return;
      document.getElementById('online').textContent = d.online;
      boite.innerHTML = d.rooms.map(function (r) {
        return '<div class="room-card"><span class="em">' + (r.emoji || '💬') + '</span>' +
          '<span><b>' + esc(r.name) + '</b><small>' + esc(r.description || '') + '</small></span>' +
          '<span class="n">' + r.users + '</span></div>';
      }).join('');
    }).catch(function () { boite.innerHTML = '<p class="muted">Salons momentanément indisponibles.</p>'; });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  chargerSalons();
  setInterval(chargerSalons, 20000);

  /* --- entrée --- */
  var form = document.getElementById('entry');
  var err = document.getElementById('err');
  /* Le pseudo est reproposé au retour : la plupart des visiteurs reviennent
     avec le même, et le retaper à chaque fois est le premier abandon. */
  var dernier = localStorage.getItem('cn-pseudo');
  if (dernier) document.getElementById('pseudo').value = dernier;
  var age = localStorage.getItem('cn-age');
  if (age) document.getElementById('age').value = age;

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.hidden = true;
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    var data = {
      pseudo: document.getElementById('pseudo').value,
      age: document.getElementById('age').value,
      gender: document.getElementById('gender').value,
      region: document.getElementById('region').value,
    };
    fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        localStorage.setItem('cn-pseudo', data.pseudo);
        localStorage.setItem('cn-age', data.age);
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
