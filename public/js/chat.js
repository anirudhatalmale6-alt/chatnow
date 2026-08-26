/* ------------------------------------------------------------------ *
 * ChatNow — interface du tchat                                        *
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var heure = function (d) {
    var t = d ? new Date(String(d).replace(' ', 'T')) : new Date();
    if (isNaN(t)) t = new Date();
    return ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
  };

  /* ------------------------------ thème ------------------------------ */
  /* Le thème est déjà appliqué par theme.js, chargé dans <head> : ici on ne
     branche que le menu de choix. */
  if (window.CNTheme) window.CNTheme.menu($('theme'));

  /* ------------------------------ état ------------------------------- */
  var moi = null;
  var salons = [];
  var salonActuel = null;
  var vue = { type: 'room', key: null };     // room | pm
  var conversations = {};                    // uid -> { pseudo, color, messages:[], unread }
  var ignores = new Set(JSON.parse(localStorage.getItem('cn-ignore') || '[]'));
  var membres = [];
  var enTrainEcrire = {};
  var fiche = null;
  var profils = {};      // clé -> { nom, court, couleur }

  fetch('/api/profils').then(function (r) { return r.json(); }).then(function (d) {
    if (!d || !d.ok) return;
    d.profils.forEach(function (p) { profils[p.cle] = p; });
    rendreMembres();
  }).catch(function () { /* la liste s'affiche sans étiquette de profil */ });

  /* Distance à vol d'oiseau (haversine). Les coordonnées reçues sont
     arrondies au kilomètre par le serveur : le résultat est approximatif,
     et l'affichage le dit. */
  function distanceKm(a, b) {
    if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
    var R = 6371, rad = function (d) { return d * Math.PI / 180; };
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  function distanceTexte(km) {
    if (km === null) return '';
    if (km < 1) return "moins d'1 km";
    if (km < 10) return Math.round(km) + ' km';
    if (km < 100) return Math.round(km / 5) * 5 + ' km';
    return Math.round(km / 10) * 10 + ' km';
  }

  var socket = io({ transports: ['websocket', 'polling'] });

  var voix = new window.CNVoix(socket, {
    avis: function (t) { avis(t); },
    majListe: function () { rendreVoix(); rendreMembres(); },
  });

  /* --------------------------- bandeau réseau ------------------------ */
  var net = $('net');
  function reseau(etat, texte) {
    if (etat === 'ok') {
      net.classList.add('ok');
      $('netText').textContent = texte || 'Connexion rétablie.';
      net.hidden = false;
      setTimeout(function () { net.hidden = true; net.classList.remove('ok'); }, 2200);
    } else {
      net.classList.remove('ok');
      $('netText').textContent = texte || 'Connexion internet introuvable — tentative de reconnexion…';
      net.hidden = false;
    }
  }

  socket.on('connect', function () {
    if (net.hidden === false && !net.classList.contains('ok')) reseau('ok');
    /* Après une coupure, socket.io reconnecte mais le serveur a oublié dans
       quel salon nous étions : il faut le rejoindre à nouveau, sinon on reste
       connecté sans jamais recevoir un seul message. */
    if (salonActuel) socket.emit('room:join', { slug: salonActuel.slug });
  });
  socket.on('disconnect', function () { reseau('ko'); });
  socket.io.on('reconnect_attempt', function () { reseau('ko'); });
  socket.on('server:restart', function () { reseau('ko', 'Le serveur redémarre — reconnexion automatique…'); });
  socket.on('connect_error', function (e) {
    var m = String(e && e.message || '');
    if (m.indexOf('no-session') === 0) { location.href = '/'; return; }
    if (m.indexOf('banned') === 0) {
      document.body.innerHTML = '<div class="modal"><div class="modal-box"><h2>Accès au tchat retiré</h2>' +
        '<p class="muted">' + (esc(m.slice(7)) || "Vous ne pouvez plus accéder au tchat.") + '</p>' +
        '<a class="btn" href="/">Retour à l\'accueil</a></div></div>';
      socket.close(); return;
    }
    reseau('ko');
  });

  socket.on('kicked', function (d) {
    document.body.innerHTML = '<div class="modal"><div class="modal-box"><h2>' +
      (d.banned ? 'Vous avez été banni' : 'Vous avez été exclu du tchat') + '</h2>' +
      '<p class="muted">' + (d.reason ? esc(d.reason) : 'Décision de la modération.') + '</p>' +
      '<a class="btn" href="/">Retour à l\'accueil</a></div></div>';
  });

  /* ------------------------------ session ---------------------------- */
  socket.on('session', function (u) {
    moi = u;
    $('me').innerHTML = '<span class="avatar" style="background:' + esc(u.color) + '">' + esc(u.pseudo[0]) + '</span>' +
      '<span class="nm">' + esc(u.pseudo) + (u.city ? '<div class="meta">' + esc(u.city) + '</div>' : '') + '</span>' +
      '<button class="ghost quit" id="quit" title="Quitter le tchat">⎋</button>';
    $('quit').onclick = function () {
      fetch('/api/quit', { method: 'POST' }).then(function () { location.href = '/'; });
    };
  });

  /* ------------------------------ salons ----------------------------- */
  socket.on('rooms', function (rs) {
    salons = rs;
    rendreSalons({});
    if (!salonActuel) {
      var voulu = localStorage.getItem('cn-room');
      var cible = rs.filter(function (r) { return r.slug === voulu; })[0] || rs[0];
      if (cible) rejoindre(cible.slug);
    }
  });

  var derniersCompteurs = {};
  socket.on('counts', function (d) {
    derniersCompteurs = d.rooms || {};
    $('online').textContent = d.online;
    rendreSalons(derniersCompteurs);
  });

  function rendreSalons(counts) {
    $('roomList').innerHTML = salons.map(function (r) {
      var on = salonActuel && salonActuel.slug === r.slug;
      return '<div class="room' + (on ? ' on' : '') + '" data-slug="' + esc(r.slug) + '">' +
        '<span class="em">' + esc(r.emoji || '💬') + '</span>' +
        '<span class="nm">' + esc(r.name) + (r.min_age ? ' <small>' + r.min_age + '+</small>' : '') + '</span>' +
        '<span class="n">' + (counts[r.slug] || 0) + '</span></div>';
    }).join('');
    [].forEach.call($('roomList').querySelectorAll('.room'), function (el) {
      el.onclick = function () { rejoindre(el.getAttribute('data-slug')); fermerTiroirs(); };
    });
  }

  function rejoindre(slug) {
    socket.emit('room:join', { slug: slug }, function (r) {
      if (r && !r.ok) avis(r.message);
    });
  }

  socket.on('room:joined', function (d) {
    salonActuel = d.room;
    localStorage.setItem('cn-room', d.room.slug);
    conversations['room'] = { messages: d.history.map(function (m) {
      return { id: m.id, pseudo: m.pseudo, color: m.color, body: m.body, kind: m.kind, created_at: m.created_at };
    }) };
    membres = d.users;
    vue = { type: 'room', key: d.room.slug };
    rendreSalons(derniersCompteurs);
    rendreTabs();
    rendreVue();
    rendreMembres();
    rendreBarreSalon();
  });

  socket.on('users', function (us) { membres = us; rendreMembres(); rendreVoix(); });

  /* ---------------------------- messages ----------------------------- */
  socket.on('message', function (m) {
    if (!conversations['room']) conversations['room'] = { messages: [] };
    conversations['room'].messages.push(m);
    if (conversations['room'].messages.length > 300) conversations['room'].messages.shift();
    if (vue.type === 'room') ajouterLigne(m);
  });

  socket.on('system', function (m) {
    if (vue.type !== 'room') return;
    ajouterLigne({ kind: 'system', body: m.text });
  });

  socket.on('typing', function (d) {
    if (d.uid === (moi && moi.uid) || ignores.has(d.uid)) return;
    if (d.on) enTrainEcrire[d.uid] = { pseudo: d.pseudo, t: Date.now() };
    else delete enTrainEcrire[d.uid];
    majTyping();
  });
  setInterval(function () {
    var n = Date.now(), chg = false;
    for (var k in enTrainEcrire) if (n - enTrainEcrire[k].t > 6000) { delete enTrainEcrire[k]; chg = true; }
    if (chg) majTyping();
  }, 2000);

  function majTyping() {
    if (vue.type !== 'room') { $('typing').textContent = ''; return; }
    var noms = Object.keys(enTrainEcrire).map(function (k) { return enTrainEcrire[k].pseudo; });
    if (!noms.length) { $('typing').textContent = ''; return; }
    $('typing').textContent = noms.length === 1
      ? noms[0] + " est en train d'écrire…"
      : (noms.length === 2 ? noms.join(' et ') : noms.length + ' personnes') + " sont en train d'écrire…";
  }

  /* ------------------------------ privé ------------------------------ */
  socket.on('pm', function (m) {
    var autre = (m.from === moi.uid) ? m.to : m.from;
    if (ignores.has(autre)) return;
    if (!conversations[autre]) {
      conversations[autre] = { pseudo: m.from === moi.uid ? pseudoDe(autre) : m.fromPseudo, color: m.color, messages: [], unread: 0 };
      /* L'historique REMPLACE la conversation, il ne s'y ajoute pas : chaque
         message privé est enregistré en base avant d'être envoyé, donc celui
         que l'on vient de recevoir s'y trouve déjà. En concaténant, il
         s'afficherait deux fois. */
      socket.emit('pm:history', { with: autre }, function (r) {
        if (r && r.ok && conversations[autre]) {
          conversations[autre].messages = r.messages.map(enveloppePm);
          if (vue.type === 'pm' && vue.key === autre) rendreVue();
        }
      });
    }
    conversations[autre].messages.push({
      pseudo: m.fromPseudo, color: m.color, body: m.body, created_at: m.created_at, mine: m.from === moi.uid,
    });
    if (vue.type === 'pm' && vue.key === autre) {
      ajouterLigne({ pseudo: m.fromPseudo, color: m.color, body: m.body, created_at: m.created_at, uid: m.from });
    } else if (m.from !== moi.uid) {
      conversations[autre].unread = (conversations[autre].unread || 0) + 1;
      signalerNouveau(m.fromPseudo);
    }
    rendreTabs();
  });

  var enveloppePm = function (r) {
    return { pseudo: r.from_pseudo, body: r.body, created_at: r.created_at, mine: r.from_uid === (moi && moi.uid) };
  };

  function pseudoDe(uid) {
    var u = membres.filter(function (x) { return x.uid === uid; })[0];
    return u ? u.pseudo : 'Inconnu';
  }

  function ouvrirPm(uid, pseudo, color) {
    if (!conversations[uid]) {
      conversations[uid] = { pseudo: pseudo, color: color, messages: [], unread: 0 };
      socket.emit('pm:history', { with: uid }, function (r) {
        if (r && r.ok) {
          conversations[uid].messages = r.messages.map(enveloppePm);
          if (vue.type === 'pm' && vue.key === uid) rendreVue();
        }
      });
    }
    conversations[uid].unread = 0;
    vue = { type: 'pm', key: uid };
    rendreTabs(); rendreVue();
    $('input').focus();
  }

  function rendreTabs() {
    var html = '<span class="tab' + (vue.type === 'room' ? ' on' : '') + '" data-t="room">💬 Salon</span>';
    Object.keys(conversations).forEach(function (uid) {
      if (uid === 'room') return;
      var c = conversations[uid];
      html += '<span class="tab' + (vue.type === 'pm' && vue.key === uid ? ' on' : '') + '" data-t="' + esc(uid) + '">' +
        esc(c.pseudo) + (c.unread ? ' <b class="unread">' + c.unread + '</b>' : '') +
        ' <span class="x" data-close="' + esc(uid) + '">✕</span></span>';
    });
    $('tabs').innerHTML = html;
    [].forEach.call($('tabs').querySelectorAll('.tab'), function (el) {
      el.onclick = function (ev) {
        var fermer = ev.target.getAttribute('data-close');
        if (fermer) {
          delete conversations[fermer];
          if (vue.type === 'pm' && vue.key === fermer) { vue = { type: 'room', key: salonActuel && salonActuel.slug }; rendreVue(); }
          rendreTabs();
          return;
        }
        var t = el.getAttribute('data-t');
        if (t === 'room') { vue = { type: 'room', key: salonActuel && salonActuel.slug }; }
        else { conversations[t].unread = 0; vue = { type: 'pm', key: t }; }
        rendreTabs(); rendreVue(); rendreBarreSalon();
      };
    });
  }

  /* ------------------------------ rendu ------------------------------ */
  function rendreVue() {
    var box = $('messages');
    box.innerHTML = '';
    if (vue.type === 'room') {
      $('roomName').textContent = (salonActuel ? (salonActuel.emoji || '') + ' ' + salonActuel.name : '…');
      $('roomDesc').textContent = salonActuel ? (salonActuel.description || '') : '';
      (conversations['room'] ? conversations['room'].messages : []).forEach(function (m) { ajouterLigne(m, true); });
    } else {
      var c = conversations[vue.key];
      $('roomName').textContent = '✉️ ' + (c ? c.pseudo : '');
      $('roomDesc').textContent = 'Conversation privée';
      (c ? c.messages : []).forEach(function (m) {
        ajouterLigne({ pseudo: m.mine ? (moi && moi.pseudo) : m.pseudo, color: m.mine ? (moi && moi.color) : (c.color || '#64748b'),
          body: m.body, created_at: m.created_at, uid: m.mine ? (moi && moi.uid) : vue.key }, true);
      });
    }
    majTyping();
    box.scrollTop = box.scrollHeight;
  }

  function ajouterLigne(m, sansScroll) {
    var box = $('messages');
    var colle = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    var el = document.createElement('div');

    if (m.kind === 'system') {
      el.className = 'msg sys';
      el.innerHTML = '<div class="body">' + esc(m.body) + '</div>';
    } else {
      if (m.uid && ignores.has(m.uid)) return;
      var mien = moi && (m.uid === moi.uid || (!m.uid && m.pseudo === moi.pseudo));
      el.className = 'msg' + (mien ? ' me' : '');
      el.innerHTML =
        '<span class="avatar" style="background:' + esc(m.color || '#64748b') + '">' + esc((m.pseudo || '?')[0]) + '</span>' +
        '<div class="body"><div class="who" data-uid="' + esc(m.uid || '') + '" data-pseudo="' + esc(m.pseudo || '') + '">' +
        esc(m.pseudo || '') + ' <span class="t">' + heure(m.created_at) + '</span></div>' +
        '<div class="txt">' + lien(esc(m.body)) + '</div></div>' +
        (mien ? '' : '<button class="flag" title="Signaler ce message" data-rep="' + esc(m.pseudo || '') +
          '" data-mid="' + esc(m.id || '') + '">🚩</button>');
    }
    box.appendChild(el);

    var w = el.querySelector('.who');
    if (w && w.getAttribute('data-uid')) w.onclick = function () { ouvrirFiche(w.getAttribute('data-uid')); };
    var f = el.querySelector('.flag');
    if (f) f.onclick = function () { ouvrirSignalement(f.getAttribute('data-rep'), f.getAttribute('data-mid'), m.body); };

    if (!sansScroll && colle) box.scrollTop = box.scrollHeight;
  }

  /* Les liens sont bloqués par la modération pour les visiteurs, mais un
     modérateur peut en poster : on les rend alors cliquables, en rel=nofollow
     pour ne rien transmettre au site de destination. */
  function lien(html) {
    return html.replace(/(https?:\/\/[^\s<]+)/g, function (u) {
      return '<a href="' + u + '" target="_blank" rel="noopener nofollow ugc">' + u + '</a>';
    });
  }

  /* ---------------------------- connectés ---------------------------- */
  function rendreMembres() {
    $('userCount').textContent = membres.length;

    /* Classement : d'abord les plus proches, ensuite ceux dont on ne connaît
       pas la position. Sans le second critère, les personnes sans ville
       remonteraient en tête avec une distance nulle, ce qui serait faux. */
    var liste = membres.slice().sort(function (a, b) {
      /* Soi-même toujours en tête, et signalé : sinon on se cherche dans la
         liste sans se reconnaître, la distance affichée étant nulle. */
      if (moi && a.uid === moi.uid) return -1;
      if (moi && b.uid === moi.uid) return 1;
      var da = distanceKm(moi, a), db = distanceKm(moi, b);
      if (da === null && db === null) return a.pseudo.localeCompare(b.pseudo);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });

    $('userList').innerHTML = liste.map(function (u) {
      var p = profils[u.gender] || null;
      var estMoi = moi && u.uid === moi.uid;
      var km = estMoi ? null : distanceKm(moi, u);
      var meta = '';
      if (u.age) meta += '<span>' + u.age + ' ans</span>';
      if (p && p.court) meta += '<span class="prof" style="color:' + esc(p.couleur) + '">' + esc(p.court) + '</span>';
      if (u.city) meta += '<span>' + esc(u.city) + '</span>';
      if (km !== null) meta += '<span class="km' + (km < 10 ? ' proche' : '') + '">' + esc(distanceTexte(km)) + '</span>';
      return '<div class="user' + (estMoi ? ' moi' : '') + (ignores.has(u.uid) ? ' ign' : '') +
        '" data-uid="' + esc(u.uid) + '">' +
        '<span class="avatar" style="background:' + esc(u.color) + '">' + esc(u.pseudo[0]) + '</span>' +
        '<span class="nm">' + esc(u.pseudo) + (meta ? '<div class="meta">' + meta + '</div>' : '') + '</span>' +
        (estMoi ? '<span class="tagv">vous</span>' : '') +
        (u.voice ? '<span class="tagmic" title="au micro">🎙️</span>' : '') +
        (u.role !== 'user' ? '<span class="tagm">modo</span>' : '') + '</div>';
    }).join('');

    [].forEach.call($('userList').querySelectorAll('.user'), function (el) {
      el.onclick = function () { ouvrirFiche(el.getAttribute('data-uid')); };
    });
  }

  /* --------------------- salons audio et radio ----------------------- */
  function rendreBarreSalon() {
    var bar = $('audioBar');
    var kind = (salonActuel && salonActuel.kind) || 'text';

    /* En message privé on masque la barre : la radio du salon n'a rien à
       faire au-dessus d'une conversation à deux. */
    if (vue.type !== 'room' || kind === 'text') {
      bar.hidden = true;
      $('voix').hidden = true;
      if (voix.actif) voix.quitter();
      var vieux = bar.querySelector('audio');
      if (vieux) vieux.pause();
      bar.innerHTML = '';
      return;
    }

    if (kind === 'radio') {
      bar.hidden = false;
      $('voix').hidden = true;
      var flux = salonActuel.stream_url || '';
      bar.innerHTML = flux
        ? '<span class="t">📻 ' + esc(salonActuel.name) + '</span>' +
          '<audio controls preload="none" src="' + esc(flux) + '"></audio>' +
          '<span class="sub">La radio se lance en cliquant sur ▶. Le tchat continue pendant l\'écoute.</span>'
        : '<span class="t">📻 ' + esc(salonActuel.name) + '</span>' +
          '<span class="sub">Aucun flux radio n\'est encore réglé pour ce salon (à saisir dans l\'administration).</span>';
      return;
    }

    /* kind === 'audio' */
    bar.hidden = false;
    $('voix').hidden = false;
    bar.innerHTML =
      '<span class="t">🎙️ ' + esc(salonActuel.name) + '</span>' +
      (voix.actif
        ? '<button class="btn danger" id="micOff" type="button">Quitter le micro</button>' +
          '<button class="btn light" id="micMute" type="button">' + (voix.enMuet ? '🔇 Réactiver' : '🔊 Couper mon micro') + '</button>'
        : '<button class="btn" id="micOn" type="button">🎙️ Prendre le micro</button>') +
      '<span class="sub">Le son passe directement entre les navigateurs, il ne transite pas par le serveur.</span>';

    var on = $('micOn'), off = $('micOff'), mute = $('micMute');
    if (on) on.onclick = function () {
      on.disabled = true;
      voix.rejoindre().then(function () { rendreBarreSalon(); });
    };
    if (off) off.onclick = function () { voix.quitter(); rendreBarreSalon(); };
    if (mute) mute.onclick = function () {
      voix.enMuet = !voix.enMuet;
      voix.muet(voix.enMuet);
      rendreBarreSalon();
    };
    rendreVoix();
  }

  function rendreVoix() {
    if ($('voix').hidden) return;
    var auMicro = membres.filter(function (u) { return u.voice; });
    $('voix').innerHTML = auMicro.length
      ? auMicro.map(function (u) {
          return '<span class="p"><span class="avatar" style="background:' + esc(u.color) + '">' +
            esc(u.pseudo[0]) + '</span>' + esc(u.pseudo) + '</span>';
        }).join('')
      : '<span class="sub muted">Personne au micro pour le moment.</span>';
  }

  /* ------------------------------ fiche ------------------------------ */
  function ouvrirFiche(uid) {
    if (!uid || (moi && uid === moi.uid)) return;
    var u = membres.filter(function (x) { return x.uid === uid; })[0];
    if (!u) {
      var c = conversations[uid];
      u = c ? { uid: uid, pseudo: c.pseudo, color: c.color } : null;
    }
    if (!u) return;
    fiche = u;
    var p = profils[u.gender] || null;
    var km = distanceKm(moi, u);
    $('cardAvatar').textContent = u.pseudo[0];
    $('cardAvatar').style.background = u.color || '#64748b';
    $('cardPseudo').textContent = u.pseudo;
    $('cardMeta').textContent = [
      u.age ? u.age + ' ans' : '',
      p && p.court ? p.court : '',
      u.city || '',
      km !== null ? 'à ' + distanceTexte(km) : '',
    ].filter(Boolean).join(' · ');
    $('cardIgnore').textContent = ignores.has(uid) ? '👁️ Ne plus ignorer' : '🙈 Ignorer';
    $('card').hidden = false;
  }
  $('cardClose').onclick = function () { $('card').hidden = true; };
  $('card').onclick = function (e) { if (e.target === $('card')) $('card').hidden = true; };
  $('cardPm').onclick = function () { $('card').hidden = true; ouvrirPm(fiche.uid, fiche.pseudo, fiche.color); fermerTiroirs(); };
  $('cardIgnore').onclick = function () {
    var on = !ignores.has(fiche.uid);
    if (on) ignores.add(fiche.uid); else ignores.delete(fiche.uid);
    localStorage.setItem('cn-ignore', JSON.stringify([].slice.call(ignores)));
    socket.emit('ignore', { uid: fiche.uid, on: on });
    $('card').hidden = true;
    rendreMembres(); rendreVue();
    avis(on ? 'Vous ne verrez plus les messages de ' + fiche.pseudo + '.' : 'Vous voyez de nouveau ' + fiche.pseudo + '.');
  };
  $('cardReport').onclick = function () { $('card').hidden = true; ouvrirSignalement(fiche.pseudo, null, ''); };

  /* --------------------------- signalement --------------------------- */
  var repCible = null;
  function ouvrirSignalement(pseudo, mid, contexte) {
    repCible = { pseudo: pseudo, mid: mid, contexte: contexte };
    $('repWho').textContent = pseudo;
    $('repNote').value = '';
    $('rep').hidden = false;
  }
  $('repClose').onclick = function () { $('rep').hidden = true; };
  $('rep').onclick = function (e) { if (e.target === $('rep')) $('rep').hidden = true; };
  $('repForm').addEventListener('submit', function (e) {
    e.preventDefault();
    socket.emit('report', {
      pseudo: repCible.pseudo, messageId: repCible.mid || null,
      reason: $('repReason').value,
      context: [repCible.contexte || '', $('repNote').value].filter(Boolean).join(' — '),
    }, function (r) {
      $('rep').hidden = true;
      avis(r && r.ok ? 'Signalement envoyé à la modération. Merci.' : "Le signalement n'a pas pu être envoyé.");
    });
  });

  /* ------------------------------ envoi ------------------------------ */
  var champ = $('input');
  var dernierTyping = 0;

  $('composer').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = champ.value.trim();
    if (!body) return;
    champ.value = '';
    stopTyping();

    if (vue.type === 'pm') {
      socket.emit('pm:send', { to: vue.key, body: body }, function (r) { if (r && !r.ok) avis(r.message); });
    } else {
      socket.emit('message:send', { body: body }, function (r) {
        if (r && !r.ok) avis(r.message);
        else if (r && r.masked) avis('Un mot de votre message a été masqué par la modération.');
      });
    }
  });

  champ.addEventListener('input', function () {
    if (vue.type !== 'room') return;
    var n = Date.now();
    if (n - dernierTyping > 2500) { socket.emit('typing', { on: true }); dernierTyping = n; }
    clearTimeout(champ._t);
    champ._t = setTimeout(stopTyping, 3000);
  });
  function stopTyping() { clearTimeout(champ._t); dernierTyping = 0; socket.emit('typing', { on: false }); }

  var minuterie = null;
  function avis(texte) {
    if (!texte) return;
    var n = $('notice');
    n.textContent = texte; n.hidden = false;
    clearTimeout(minuterie);
    minuterie = setTimeout(function () { n.hidden = true; }, 5000);
  }

  /* ------------------------------ emojis ----------------------------- */
  var EMOJIS = ('😀 😃 😄 😁 😅 😂 🙂 😉 😊 😍 😘 😗 🤗 🤔 😐 😴 😪 😷 🤒 🥳 😎 🤓 😕 😢 😭 😤 😡 🤬 😱 😨 ' +
    '👍 👎 👏 🙌 🤝 🙏 💪 ✌️ 👋 🤞 ❤️ 💔 💕 💯 🔥 ⭐ 🎉 🎂 🎁 ☕ 🍺 🍕 🌞 🌙 🌧️ ⚽ 🎮 🎬 🎵 📚').split(' ');
  var pop = $('emojiPop');
  pop.innerHTML = EMOJIS.map(function (e) { return '<button type="button">' + e + '</button>'; }).join('');
  $('emojiBtn').onclick = function (e) { e.stopPropagation(); pop.hidden = !pop.hidden; };
  pop.onclick = function (e) {
    if (e.target.tagName !== 'BUTTON') return;
    champ.value += e.target.textContent;
    champ.focus();
    pop.hidden = true;
  };
  document.addEventListener('click', function (e) {
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $('emojiBtn')) pop.hidden = true;
  });

  /* --------------------- notification d'un privé --------------------- */
  var titreOrigine = document.title;
  var clignote = null;
  function signalerNouveau(pseudo) {
    if (document.hasFocus()) return;
    clearInterval(clignote);
    var on = false;
    clignote = setInterval(function () {
      document.title = (on = !on) ? '💬 ' + pseudo + ' vous écrit…' : titreOrigine;
    }, 1200);
    bip();
  }
  window.addEventListener('focus', function () { clearInterval(clignote); document.title = titreOrigine; });

  /* Un son court fabriqué à la volée : pas de fichier à télécharger, et donc
     rien qui bloque l'affichage du tchat au premier chargement. */
  function bip() {
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      var ctx = new C(), o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 660; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.start(); o.stop(ctx.currentTime + 0.36);
      setTimeout(function () { ctx.close(); }, 600);
    } catch (e) { /* le navigateur refuse le son avant interaction : sans importance */ }
  }

  /* ------------------------- tiroirs (mobile) ------------------------ */
  var voile = document.createElement('div');
  voile.className = 'veil';
  document.body.appendChild(voile);
  function ouvrirTiroir(el) { el.classList.add('open'); voile.classList.add('on'); }
  function fermerTiroirs() {
    $('colRooms').classList.remove('open');
    $('colUsers').classList.remove('open');
    voile.classList.remove('on');
  }
  $('openRooms').onclick = function () { ouvrirTiroir($('colRooms')); };
  $('openUsers').onclick = function () { ouvrirTiroir($('colUsers')); };
  $('closeRooms').onclick = fermerTiroirs;
  $('closeUsers').onclick = fermerTiroirs;
  voile.onclick = fermerTiroirs;
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('card').hidden) { $('card').hidden = true; return; }
    if (!$('rep').hidden) { $('rep').hidden = true; return; }
    fermerTiroirs();
  });
})();
