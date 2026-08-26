"""Parcours complet à deux navigateurs : entrée, salon, message, filtre,
message privé, « est en train d'écrire », signalement, mobile, administration.

Chaque étape est VÉRIFIÉE dans l'autre navigateur : un message qui s'affiche
chez celui qui l'écrit ne prouve rien, il peut n'être jamais parti.
"""
import sys, time, os, io
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE", "http://127.0.0.1:3011")
SHOTS = os.environ.get("SHOTS", os.path.join(os.path.dirname(__file__), "shots"))
os.makedirs(SHOTS, exist_ok=True)

def env(cle, defaut=""):
    """Le mot de passe d'administration est lu dans .env, jamais écrit ici :
    un mot de passe en dur dans un fichier suivi par Git finit toujours par
    être pris pour le vrai."""
    if os.environ.get(cle):
        return os.environ[cle]
    chemin = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(chemin):
        for ligne in io.open(chemin, encoding="utf-8"):
            if ligne.strip().startswith(cle + "="):
                return ligne.split("=", 1)[1].strip()
    return defaut

ok, fails = 0, []
def check(label, cond):
    global ok
    if cond:
        ok += 1
        print("  ok  %s" % label)
    else:
        fails.append(label)
        print("  ÉCHEC %s" % label)

def entrer(ctx, pseudo, age, gender="a", region=""):
    p = ctx.new_page()
    p.set_viewport_size({"width": 1280, "height": 760})
    p.goto(BASE, wait_until="domcontentloaded")
    p.fill("#pseudo", pseudo)
    p.fill("#age", str(age))
    p.select_option("#gender", gender)
    if region:
        p.fill("#region", region)
    p.click("#entry button[type=submit]")
    p.wait_for_url("**/chat", timeout=15000)
    p.wait_for_selector(".room.on", timeout=15000)
    return p

def envoyer(page, texte):
    page.fill("#input", texte)
    page.press("#input", "Enter")

def attendre_notice(page, fragment, timeout=8000):
    """Le bandeau d'avertissement reste affiché 5 secondes. Attendre qu'il soit
    « visible » ne prouve donc rien : il peut encore porter le message
    PRÉCÉDENT. On attend le texte attendu, pas la simple visibilité."""
    try:
        page.wait_for_function(
            "f => { const n = document.getElementById('notice');"
            "       return n && !n.hidden && n.textContent.includes(f); }",
            arg=fragment, timeout=timeout)
        return True
    except Exception:
        return False

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ca = b.new_context(locale="fr-FR")
    cb = b.new_context(locale="fr-FR")

    # ---------- accueil ----------
    home = ca.new_page()
    home.set_viewport_size({"width": 1280, "height": 760})
    home.goto(BASE, wait_until="networkidle")
    check("accueil : salons affichés", home.locator(".room-card").count() >= 5)
    home.screenshot(path=f"{SHOTS}/01-accueil.png")
    home.close()

    # ---------- entrée refusée ----------
    bad = ca.new_page()
    bad.goto(BASE, wait_until="domcontentloaded")
    bad.fill("#pseudo", "ad")           # trop court
    bad.fill("#age", "30")
    bad.click("#entry button[type=submit]")
    bad.wait_for_selector("#err:not([hidden])", timeout=8000)
    check("pseudo trop court refusé", "Pseudo invalide" in bad.inner_text("#err"))
    bad.fill("#pseudo", "Moderateur")
    bad.click("#entry button[type=submit]")
    bad.wait_for_timeout(600)
    check("pseudo réservé refusé", "réservé" in bad.inner_text("#err"))
    # L'âge est déjà bloqué par le navigateur (input type=number min=15), donc
    # un test à la souris ne prouverait rien du serveur. On appelle l'API
    # directement, comme le ferait quelqu'un qui contourne le formulaire.
    rep = bad.evaluate("""async () => {
      const r = await fetch('/api/join', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({pseudo:'Camille', age:12, gender:'a'})});
      return {status: r.status, body: await r.json()};
    }""")
    check("âge trop bas refusé par le serveur, formulaire contourné",
          rep["status"] == 400 and "ge requis" in rep["body"].get("message", ""))
    bad.close()

    # ---------- deux visiteurs ----------
    A = entrer(ca, "Camille", 29, "f", "Occitanie")
    B = entrer(cb, "Julien", 34, "h", "Bretagne")

    A.wait_for_timeout(900)
    check("A voit B dans les connectés", "Julien" in A.inner_text("#userList"))
    check("B voit A dans les connectés", "Camille" in B.inner_text("#userList"))
    check("compteur de connectés", A.inner_text("#online").strip() == "2")

    # ---------- message public ----------
    envoyer(A, "Bonjour tout le monde, quelqu'un est de Toulouse ?")
    B.wait_for_selector("text=quelqu'un est de Toulouse", timeout=8000)
    check("le message de A arrive chez B", "Toulouse" in B.inner_text("#messages"))
    envoyer(B, "Salut Camille ! Moi je suis de Rennes 😀")
    A.wait_for_selector("text=Rennes", timeout=8000)
    check("la réponse de B arrive chez A", "Rennes" in A.inner_text("#messages"))

    # ---------- « est en train d'écrire » ----------
    A.fill("#input", "je réfléchis")
    B.wait_for_timeout(700)
    check("B voit « Camille est en train d'écrire »", "en train d'écrire" in B.inner_text("#typing"))
    A.fill("#input", "")

    # ---------- filtre : insulte masquée ----------
    envoyer(A, "tu es vraiment un connard")
    B.wait_for_timeout(900)
    txt = B.inner_text("#messages")
    check("insulte masquée chez B", "connard" not in txt and "c******" in txt)

    # ---------- filtre : lien refusé ----------
    envoyer(A, "venez voir sur http://mon-site-arnaque.com")
    check("lien refusé avec explication", attendre_notice(A, "liens"))
    B.wait_for_timeout(500)
    check("le lien n'est jamais arrivé chez B", "mon-site-arnaque" not in B.inner_text("#messages"))

    # ---------- filtre : numéro refusé ----------
    envoyer(A, "appelle moi au 06 12 34 56 78")
    check("numéro refusé", attendre_notice(A, "num"))
    check("le numéro n'est pas arrivé chez B", "06 12 34" not in B.inner_text("#messages"))

    # ---------- anti-flood ----------
    for i in range(7):
        envoyer(A, "message rapide numéro %d" % i)
        A.wait_for_timeout(120)
    check("anti-flood déclenché", attendre_notice(A, "trop vite"))

    A.screenshot(path=f"{SHOTS}/02-salon.png")

    # ---------- message privé ----------
    B.click("#userList .user:has-text('Camille')")
    B.wait_for_selector("#card:not([hidden])", timeout=6000)
    check("fiche du participant ouverte", "Camille" in B.inner_text("#cardPseudo"))
    B.screenshot(path=f"{SHOTS}/03-fiche.png")
    B.click("#cardPm")
    B.wait_for_timeout(400)
    envoyer(B, "Salut, on discute en privé ?")
    A.wait_for_timeout(1200)
    check("A reçoit une notification d'onglet privé", "Julien" in A.inner_text("#tabs"))
    A.click("#tabs .tab:has-text('Julien')")
    A.wait_for_timeout(700)
    check("A lit le message privé", "on discute en priv" in A.inner_text("#messages"))
    # Le message est enregistré en base AVANT d'être envoyé : si l'historique
    # s'ajoutait au message reçu en direct au lieu de le remplacer, il
    # s'afficherait deux fois.
    check("le message privé n'apparaît qu'une seule fois",
          A.inner_text("#messages").count("on discute en priv") == 1)
    envoyer(A, "Oui bien sûr !")
    B.wait_for_timeout(900)
    check("B reçoit la réponse privée", "Oui bien s" in B.inner_text("#messages"))
    B.screenshot(path=f"{SHOTS}/04-prive.png")

    # ---------- signalement ----------
    A.click("#tabs .tab:has-text('Salon')")
    A.wait_for_timeout(400)
    A.hover("#messages .msg:not(.me) >> nth=-1")
    A.click("#messages .msg:not(.me) .flag >> nth=-1")
    A.wait_for_selector("#rep:not([hidden])", timeout=6000)
    A.fill("#repNote", "Comportement insistant.")
    A.screenshot(path=f"{SHOTS}/05-signalement.png")
    A.click("#repForm button[type=submit]")
    check("signalement confirmé", attendre_notice(A, "Signalement envoy"))

    # ---------- ignorer ----------
    A.click("#userList .user:has-text('Julien')")
    A.wait_for_selector("#card:not([hidden])", timeout=6000)
    A.click("#cardIgnore")
    A.wait_for_timeout(400)
    envoyer(B, "tu me vois encore ?")
    A.wait_for_timeout(900)
    check("les messages de la personne ignorée ne s'affichent plus",
          "tu me vois encore" not in A.inner_text("#messages"))

    # ---------- salon réservé aux majeurs ----------
    C = entrer(b.new_context(locale="fr-FR"), "Theo", 16)
    C.click("#roomList .room:has-text('Rencontres')")
    check("salon 18+ refusé à un mineur", attendre_notice(C, "18 ans et plus"))
    C.click("#roomList .room:has-text('Jeux vidéo')")
    C.wait_for_timeout(700)
    check("salon tout public accepté", "Jeux" in C.inner_text("#roomName"))
    C.close()

    # ---------- mobile ----------
    M = cb.new_page()
    M.set_viewport_size({"width": 390, "height": 780})
    M.goto(f"{BASE}/chat", wait_until="domcontentloaded")
    M.wait_for_selector(".room.on", timeout=10000)
    M.wait_for_timeout(800)
    M.screenshot(path=f"{SHOTS}/06-mobile.png")
    M.click("#openRooms")
    M.wait_for_timeout(400)
    check("tiroir des salons ouvert sur mobile", M.locator("#colRooms.open").count() == 1)
    M.screenshot(path=f"{SHOTS}/07-mobile-salons.png")
    M.click("#closeRooms")
    M.wait_for_timeout(400)
    check("tiroir refermé", M.locator("#colRooms.open").count() == 0)
    M.click("#openUsers")
    M.wait_for_timeout(400)
    check("tiroir des connectés ouvert", M.locator("#colUsers.open").count() == 1)
    M.close()

    # ---------- pas de débordement horizontal ----------
    for w in (320, 360, 390, 480, 640, 768, 900, 1024, 1280, 1600):
        p = cb.new_page()
        p.set_viewport_size({"width": w, "height": 720})
        p.goto(f"{BASE}/chat", wait_until="domcontentloaded")
        p.wait_for_timeout(500)
        deborde = p.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
        check("pas de débordement horizontal à %dpx" % w, not deborde)
        p.close()

    # ---------- thème sombre ----------
    A.click("#theme")
    A.wait_for_timeout(400)
    check("thème sombre appliqué", A.evaluate("() => document.documentElement.getAttribute('data-theme')") == "dark")
    A.screenshot(path=f"{SHOTS}/08-sombre.png")
    A.click("#theme")

    # ---------- administration ----------
    ADM = ca.new_page()
    ADM.set_viewport_size({"width": 1280, "height": 900})
    ADM.goto(f"{BASE}/admin", wait_until="domcontentloaded")
    check("administration protégée", "/admin/login" in ADM.url)
    ADM.fill("input[name=password]", "mauvais")
    ADM.click("form button")
    ADM.wait_for_timeout(500)
    check("mauvais mot de passe refusé", "err=1" in ADM.url or "incorrect" in ADM.content())
    ADM.fill("input[name=password]", env("ADMIN_PASSWORD"))
    ADM.click("form button")
    ADM.wait_for_timeout(800)
    check("tableau de bord accessible", "Tableau de bord" in ADM.inner_text("h1"))
    ADM.screenshot(path=f"{SHOTS}/09-admin.png")
    ADM.goto(f"{BASE}/admin/reports", wait_until="domcontentloaded")
    check("le signalement est arrivé en administration", "Julien" in ADM.content())
    ADM.screenshot(path=f"{SHOTS}/10-admin-signalements.png")
    ADM.goto(f"{BASE}/admin/log", wait_until="domcontentloaded")
    contenu = ADM.content()
    check("journal : le lien refusé est tracé", "link" in contenu)
    check("journal : le numéro refusé est tracé", "phone" in contenu)
    ADM.goto(f"{BASE}/admin/words", wait_until="domcontentloaded")
    ADM.screenshot(path=f"{SHOTS}/11-admin-mots.png")
    ADM.close()

    A.close(); B.close()
    b.close()

print("\n%d contrôles passés, %d échec(s)." % (ok, len(fails)))
for f in fails:
    print("  ✗ " + f)
sys.exit(1 if fails else 0)
