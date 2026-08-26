/* ------------------------------------------------------------------ *
 * Salons audio (micro) et salons radio                                *
 * ------------------------------------------------------------------ *
 * Le son NE PASSE PAS par le serveur : chaque navigateur ouvre une
 * connexion directe (WebRTC) vers les autres personnes au micro. Le
 * serveur ne transmet que les messages de mise en relation. C'est ce qui
 * permet de tenir un salon audio sur un petit serveur.
 *
 * Conséquence assumée : chacun envoie son flux à tous les autres. À huit
 * personnes, cela fait sept envois par personne — c'est la limite du
 * procédé, et c'est pour ça que le nombre de micros est plafonné.
 *
 * Rappel important : le navigateur n'autorise le micro QUE sur une adresse
 * en https (ou en localhost). Sur une adresse IP en http, Chrome refuse
 * sans afficher la moindre explication — d'où le message ci-dessous.
 */
(function (global) {
  'use strict';

  function Voix(socket, opts) {
    this.socket = socket;
    this.avis = (opts && opts.avis) || function () {};
    this.majListe = (opts && opts.majListe) || function () {};
    this.flux = null;                 // mon micro
    this.pairs = {};                  // uid -> RTCPeerConnection
    this.audios = {};                 // uid -> <audio>
    this.actif = false;
    this.ice = [{ urls: 'stun:stun.l.google.com:19302' }];

    var self = this;
    fetch('/api/webrtc').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok && d.iceServers && d.iceServers.length) self.ice = d.iceServers;
    }).catch(function () { /* on garde le serveur STUN par défaut */ });

    socket.on('voice:signal', function (m) { self._signal(m); });
    socket.on('voice:peer', function (p) {
      if (!p.on) self._ferme(p.uid);
      self.majListe();
    });
  }

  Voix.prototype.disponible = function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.RTCPeerConnection);
  };

  /* Un contexte « sûr » : https, ou localhost pendant le développement. */
  Voix.prototype.contexteSur = function () {
    return global.isSecureContext === true;
  };

  Voix.prototype.rejoindre = function () {
    var self = this;
    if (this.actif) return Promise.resolve(true);
    if (!this.contexteSur()) {
      this.avis("Le micro n'est possible qu'en https. Sur une adresse non sécurisée, le navigateur le refuse.");
      return Promise.resolve(false);
    }
    if (!this.disponible()) {
      this.avis("Votre navigateur ne gère pas le micro. Essayez Chrome, Firefox ou Safari à jour.");
      return Promise.resolve(false);
    }

    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    }).then(function (flux) {
      self.flux = flux;
      return new Promise(function (resolve) {
        self.socket.emit('voice:join', {}, function (r) {
          if (!r || !r.ok) {
            self._coupeFlux();
            self.avis((r && r.message) || "Impossible de prendre le micro.");
            return resolve(false);
          }
          self.actif = true;
          /* C'est celui qui ARRIVE qui appelle les autres. Si les deux côtés
             lançaient une offre, les deux connexions se croiseraient et
             aucune ne s'établirait. */
          (r.pairs || []).forEach(function (p) { self._appelle(p.uid); });
          self.majListe();
          resolve(true);
        });
      });
    }).catch(function (e) {
      var m = String((e && e.name) || '');
      if (m === 'NotAllowedError') self.avis("Vous avez refusé l'accès au micro. Autorisez-le dans la barre d'adresse pour parler.");
      else if (m === 'NotFoundError') self.avis("Aucun micro détecté sur cet appareil.");
      else self.avis("Micro indisponible : " + (e && e.message ? e.message : 'erreur inconnue'));
      return false;
    });
  };

  Voix.prototype.quitter = function () {
    this.actif = false;
    this.socket.emit('voice:leave');
    var self = this;
    Object.keys(this.pairs).forEach(function (uid) { self._ferme(uid); });
    this._coupeFlux();
    this.majListe();
  };

  Voix.prototype.muet = function (on) {
    if (!this.flux) return;
    this.flux.getAudioTracks().forEach(function (t) { t.enabled = !on; });
  };

  Voix.prototype._coupeFlux = function () {
    if (!this.flux) return;
    /* Sans ce stop(), la petite pastille rouge « micro en cours » reste
       allumée dans l'onglet alors que la personne a quitté le micro. */
    this.flux.getTracks().forEach(function (t) { t.stop(); });
    this.flux = null;
  };

  Voix.prototype._connexion = function (uid) {
    if (this.pairs[uid]) return this.pairs[uid];
    var self = this;
    var pc = new RTCPeerConnection({ iceServers: this.ice });
    this.pairs[uid] = pc;

    if (this.flux) this.flux.getTracks().forEach(function (t) { pc.addTrack(t, self.flux); });

    pc.onicecandidate = function (e) {
      if (e.candidate) self.socket.emit('voice:signal', { to: uid, data: { candidate: e.candidate } });
    };
    pc.ontrack = function (e) {
      var a = self.audios[uid];
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true;
        a.playsInline = true;
        self.audios[uid] = a;
        document.body.appendChild(a);
      }
      a.srcObject = e.streams[0];
      /* Certains navigateurs refusent la lecture automatique tant que la
         personne n'a rien cliqué. Ici elle vient de cliquer sur « prendre le
         micro », donc ça passe — mais on ne laisse pas l'erreur remonter. */
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') self._ferme(uid);
    };
    return pc;
  };

  Voix.prototype._appelle = function (uid) {
    var self = this;
    var pc = this._connexion(uid);
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () {
      self.socket.emit('voice:signal', { to: uid, data: { sdp: pc.localDescription } });
    }).catch(function () { self._ferme(uid); });
  };

  Voix.prototype._signal = function (m) {
    var self = this;
    var uid = m.from;
    var d = m.data || {};
    if (!this.actif) return;      // on ne monte pas d'audio si on n'est pas au micro

    var pc = this._connexion(uid);
    if (d.sdp) {
      pc.setRemoteDescription(new RTCSessionDescription(d.sdp)).then(function () {
        if (d.sdp.type !== 'offer') return null;
        return pc.createAnswer().then(function (a) { return pc.setLocalDescription(a); }).then(function () {
          self.socket.emit('voice:signal', { to: uid, data: { sdp: pc.localDescription } });
        });
      }).catch(function () { self._ferme(uid); });
    } else if (d.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(function () { /* candidat tardif */ });
    }
  };

  Voix.prototype._ferme = function (uid) {
    var pc = this.pairs[uid];
    if (pc) { try { pc.close(); } catch (e) {} delete this.pairs[uid]; }
    var a = this.audios[uid];
    if (a) { a.srcObject = null; a.remove(); delete this.audios[uid]; }
  };

  global.CNVoix = Voix;
})(window);
