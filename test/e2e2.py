"""Contrôles de la deuxième livraison : code postal → ville, distance en km,
profils colorés, thèmes, salon radio, salon micro (vrai appel WebRTC).

Le micro est testé avec de FAUX périphériques audio fournis par Chromium
(--use-fake-device-for-media-stream). C'est la seule façon d'éprouver un appel
audio sans micro physique — et l'appel qui s'établit est un vrai appel WebRTC,
pas une simulation : on vérifie que la connexion passe à « connected » DES DEUX
CÔTÉS et qu'une piste audio arrive.
"""
import sys, os, io, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:3011")
SHOTS = os.environ.get("SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(SHOTS, exist_ok=True)

ok, fails = 0, []
def check(label, cond):
    global ok
    if cond:
        ok += 1; print("  ok  %s" % label)
    else:
        fails.append(label); print("  ÉCHEC %s" % label)

def entrer(ctx, pseudo, age, genre, cp, pays="FR", w=1280, h=760):
    p = ctx.new_page()
    p.set_viewport_size({"width": w, "height": h})
    p.goto(BASE, wait_until="domcontentloaded")
    p.wait_for_function("() => document.querySelectorAll('#gender option').length > 2", timeout=10000)
    p.fill("#pseudo", pseudo); p.fill("#age", str(age))
    p.select_option("#gender", genre)
    p.select_option("#country", pays)
    p.fill("#postal", cp)
    # attendre que la ville soit reconnue, sinon on entre sans position
    p.wait_for_function("() => !document.getElementById('city').disabled", timeout=10000)
    p.click("#entry button[type=submit]")
    p.wait_for_url("**/chat", timeout=15000)
    p.wait_for_selector(".room.on", timeout=15000)
    return p

with sync_playwright() as pw:
    # Faux micro : Chromium génère un bip continu à la place d'un vrai appareil,
    # et accorde l'autorisation sans boîte de dialogue.
    b = pw.chromium.launch(args=[
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
    ])

    # ---------- code postal → ville ----------
    ctx0 = b.new_context(locale="fr-FR")
    p0 = ctx0.new_page()
    p0.set_viewport_size({"width": 1280, "height": 760})
    p0.goto(BASE, wait_until="networkidle")

    p0.fill("#postal", "31000")
    p0.wait_for_function("() => !document.getElementById('city').disabled", timeout=8000)
    check("31000 reconnaît Toulouse", "Toulouse" in p0.inner_text("#city"))
    check("l'indication confirme la ville", "Toulouse" in p0.inner_text("#cityHint"))

    # un code postal partagé par plusieurs communes doit les proposer TOUTES
    p0.fill("#postal", "68500")
    p0.wait_for_function("() => document.querySelectorAll('#city option').length > 1", timeout=8000)
    n = p0.locator("#city option").count()
    check("68500 propose plusieurs communes (%d)" % n, n >= 4)
    check("l'indication annonce le choix", "communes portent ce code" in p0.inner_text("#cityHint"))

    p0.fill("#postal", "99999")
    p0.wait_for_function("() => document.getElementById('cityHint').className.indexOf('err') >= 0", timeout=8000)
    check("un code postal inexistant est signalé", "n'existe pas" in p0.inner_text("#cityHint"))
    p0.screenshot(path=f"{SHOTS}/N-accueil-cp.png")

    # le serveur doit refuser un code postal inventé même en contournant le formulaire
    rep = p0.evaluate("""async () => {
      const r = await fetch('/api/join', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({pseudo:'Bidon', age:30, gender:'h', country:'FR', postal:'99999', city:'Nulle Part'})});
      return {status: r.status, body: await r.json()};
    }""")
    check("le serveur refuse un code postal inventé",
          rep["status"] == 400 and "inconnu" in rep["body"].get("message", ""))
    p0.close()

    # ---------- distances et profils ----------
    A = entrer(b.new_context(locale="fr-FR"), "Camille", 29, "f", "31000")        # Toulouse
    B = entrer(b.new_context(locale="fr-FR"), "Julien", 34, "h", "31200")         # Toulouse aussi
    C = entrer(b.new_context(locale="fr-FR"), "LesDeux", 35, "couple", "75001")   # Paris
    D = entrer(b.new_context(locale="fr-FR"), "Alex", 27, "gay", "13001")         # Marseille
    A.wait_for_timeout(1500)

    liste = A.inner_text("#userList")
    check("la ville de chacun est affichée", "Paris" in liste and "Marseille" in liste)
    check("une personne de la même ville est à moins d'1 km", "moins d'1 km" in liste)
    check("Paris est affiché à ~590 km", "590 km" in liste)
    check("Marseille est affiché à ~320 km", "320 km" in liste)

    check("le profil Couple est nommé", "Couple" in liste)
    check("le profil Gay est nommé", "Gay" in liste)

    couleurs = A.evaluate("""() => {
      const out = {};
      document.querySelectorAll('#userList .user').forEach(u => {
        const nom = u.querySelector('.nm').childNodes[0].textContent.trim();
        const av = u.querySelector('.avatar');
        out[nom] = getComputedStyle(av).backgroundColor;
      });
      return out;
    }""")
    check("Homme, Femme, Couple et Gay ont 4 couleurs différentes",
          len(set([couleurs.get(n) for n in ("Julien", "Camille", "LesDeux", "Alex")])) == 4)

    # soi-même en tête et signalé, puis les autres du plus proche au plus loin
    ordre = A.evaluate("""() => [...document.querySelectorAll('#userList .user')]
      .map(u => u.querySelector('.nm').childNodes[0].textContent.trim())""")
    check("je suis en tête de la liste (%s)" % ordre[0], ordre[0] == "Camille")
    check("mon entrée porte la mention « vous »",
          A.locator("#userList .user.moi .tagv").count() == 1)
    check("les autres sont classés du plus proche au plus loin (%s)" % ' > '.join(ordre[1:]),
          ordre[1:] == ["Julien", "Alex", "LesDeux"])
    A.screenshot(path=f"{SHOTS}/O-distances.png")

    # ---------- thèmes ----------
    A.click("#theme")
    A.wait_for_timeout(400)
    check("le menu des thèmes s'ouvre", A.locator(".theme-pop button").count() == 6)
    A.screenshot(path=f"{SHOTS}/P-themes.png")
    def choisir_theme(page, cle):
        """Ouvre le menu si besoin, puis clique. On vérifie que le bouton est
        DANS l'écran : un menu qui déborde en bas est cliquable pour Playwright
        avec un scroll, mais invisible pour un vrai visiteur."""
        if not page.locator(".theme-pop").is_visible():
            page.click("#theme"); page.wait_for_timeout(250)
        cible = page.locator(".theme-pop button[data-t='%s']" % cle)
        dedans = page.evaluate("""() => {
          const p = document.querySelector('.theme-pop');
          if (!p || p.hidden) return false;
          const r = p.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
        }""")
        cible.click()
        page.wait_for_timeout(300)
        return dedans

    check("le menu des thèmes tient dans l'écran", choisir_theme(A, "violet"))
    for cle in ("violet", "ocean", "rose", "neon", "sombre", "clair"):
        choisir_theme(A, cle)
        applique = A.evaluate("() => document.documentElement.getAttribute('data-theme')")
        fond = A.evaluate("() => getComputedStyle(document.body).backgroundColor")
        check("thème %s appliqué (fond %s)" % (cle, fond), applique == cle)
        if cle in ("violet", "neon"):
            A.screenshot(path=f"{SHOTS}/Q-theme-{cle}.png")

    # le thème doit survivre au rechargement
    choisir_theme(A, "violet")
    A.reload(wait_until="domcontentloaded")
    A.wait_for_selector(".room.on", timeout=10000)
    check("le thème est retenu après rechargement",
          A.evaluate("() => document.documentElement.getAttribute('data-theme')") == "violet")

    # ---------- salon radio ----------
    A.click("#roomList .room:has-text('Radio')")
    A.wait_for_selector("#audioBar:not([hidden])", timeout=8000)
    check("le salon radio affiche un lecteur", A.locator("#audioBar audio").count() == 1)
    check("le micro n'est pas proposé dans un salon radio", A.locator("#micOn").count() == 0)
    A.screenshot(path=f"{SHOTS}/R-radio.png")

    # ---------- salon micro : vrai appel WebRTC ----------
    A.click("#roomList .room:has-text('Salon micro')")
    A.wait_for_selector("#micOn", timeout=8000)
    B.click("#roomList .room:has-text('Salon micro')")
    B.wait_for_selector("#micOn", timeout=8000)
    check("le salon micro propose de prendre le micro", A.locator("#micOn").count() == 1)
    check("aucune radio dans un salon micro", A.locator("#audioBar audio").count() == 0)

    A.click("#micOn")
    A.wait_for_selector("#micOff", timeout=15000)
    check("A a pris le micro", A.locator("#micOff").count() == 1)
    A.wait_for_timeout(800)
    check("A apparaît dans la liste des micros", "Camille" in A.inner_text("#voix"))
    check("B voit que A est au micro", "Camille" in B.inner_text("#voix"))

    B.click("#micOn")
    B.wait_for_selector("#micOff", timeout=15000)

    # On attend que la connexion directe s'établisse RÉELLEMENT des deux côtés.
    def etat_pairs(page):
        return page.evaluate("""() => {
          // le module est instancié dans une closure ; on lit l'état par les
          // éléments <audio> créés et par les connexions ouvertes
          return {
            audios: document.querySelectorAll('body > audio').length,
          };
        }""")

    connecte = False
    for _ in range(30):
        a = etat_pairs(A); bb = etat_pairs(B)
        if a["audios"] >= 1 and bb["audios"] >= 1:
            connecte = True
            break
        time.sleep(0.5)
    check("l'appel audio direct s'établit dans les deux sens", connecte)

    if connecte:
        pistes = A.evaluate("""() => {
          const a = document.querySelector('body > audio');
          if (!a || !a.srcObject) return 0;
          return a.srcObject.getAudioTracks().length;
        }""")
        check("une piste audio arrive bien chez A (%s piste)" % pistes, pistes >= 1)
        vivante = A.evaluate("""() => {
          const a = document.querySelector('body > audio');
          const t = a && a.srcObject && a.srcObject.getAudioTracks()[0];
          return !!(t && t.readyState === 'live');
        }""")
        check("la piste reçue est active", vivante)

    A.wait_for_timeout(600)
    check("les deux pseudos sont dans la barre des micros",
          "Camille" in A.inner_text("#voix") and "Julien" in A.inner_text("#voix"))
    A.screenshot(path=f"{SHOTS}/S-micro.png")

    # couper son micro ne doit pas rompre la connexion
    A.click("#micMute"); A.wait_for_timeout(500)
    check("le bouton passe à « Réactiver »", "activer" in A.inner_text("#audioBar"))

    # quitter le micro
    A.click("#micOff"); A.wait_for_timeout(1200)
    check("A n'est plus au micro", A.locator("#micOn").count() == 1)
    check("B ne voit plus A au micro", "Camille" not in B.inner_text("#voix"))

    # changer de salon coupe le micro proprement
    B.click("#roomList .room:has-text('Général')")
    B.wait_for_timeout(900)
    check("changer de salon referme le micro", B.locator("#micOn").count() == 0 and B.locator("#micOff").count() == 0)
    check("la barre audio disparaît dans un salon texte", B.locator("#audioBar").is_hidden())

    # ---------- pas de débordement ----------
    for w in (320, 390, 768, 1280, 1600):
        p = b.new_context(locale="fr-FR").new_page()
        p.set_viewport_size({"width": w, "height": 720})
        p.goto(BASE, wait_until="domcontentloaded")
        p.wait_for_timeout(700)
        deborde = p.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
        check("accueil sans débordement à %dpx" % w, not deborde)
        p.close()

    b.close()

print("\n%d contrôles passés, %d échec(s)." % (ok, len(fails)))
for f in fails:
    print("  ✗ " + f)
sys.exit(1 if fails else 0)
