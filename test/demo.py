"""Génère les captures d'écran de présentation : une conversation réaliste à
quatre, plus la vue mobile, le thème sombre et un message privé.
Rien à voir avec les tests : ce fichier ne vérifie rien, il illustre.
"""
import os, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:3011")
SHOTS = "/var/lib/freelancer/projects/40562019/chatnow/test/shots"
os.makedirs(SHOTS, exist_ok=True)

GENS = [
    ("Camille", 29, "f", "Occitanie"),
    ("Julien", 34, "h", "Bretagne"),
    ("Sofia", 26, "f", "Île-de-France"),
    ("Marc", 41, "h", "Grand Est"),
]

CONVERSATION = [
    ("Camille", "Bonjour tout le monde ! Première fois ici, ça a l'air sympa 😀"),
    ("Julien", "Salut Camille, bienvenue ! On est plutôt tranquilles dans ce salon."),
    ("Sofia", "Coucou 👋 quelqu'un a vu le match hier soir ?"),
    ("Marc", "Oui ! La deuxième mi-temps était incroyable"),
    ("Julien", "J'ai raté ça, je bossais. Ça a fini comment ?"),
    ("Marc", "3-2 dans les arrêts de jeu, du grand n'importe quoi 😅"),
    ("Camille", "Moi je suis plus série que foot, je viens de finir une saison entière ce week-end"),
    ("Sofia", "Haha la honte, moi aussi. Vive le dimanche pluvieux ☕"),
    ("Julien", "Vous êtes d'où sinon ? Moi Rennes"),
    ("Camille", "Toulouse ! Il fait 28 degrés ici, je ne me plains pas"),
    ("Sofia", "Paris... on échange quand tu veux 😄"),
]

def entrer(ctx, pseudo, age, gender, region, w=1280, h=760):
    p = ctx.new_page()
    p.set_viewport_size({"width": w, "height": h})
    p.goto(BASE, wait_until="domcontentloaded")
    p.fill("#pseudo", pseudo); p.fill("#age", str(age))
    p.select_option("#gender", gender); p.fill("#region", region)
    p.click("#entry button[type=submit]")
    p.wait_for_url("**/chat", timeout=15000)
    p.wait_for_selector(".room.on", timeout=15000)
    return p

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pages = {}
    for pseudo, age, g, r in GENS:
        ctx = b.new_context(locale="fr-FR")
        pages[pseudo] = entrer(ctx, pseudo, age, g, r)
        time.sleep(0.3)

    # page d'accueil, une fois que des gens sont connectés
    home = b.new_context(locale="fr-FR").new_page()
    home.set_viewport_size({"width": 1280, "height": 760})
    home.goto(BASE, wait_until="networkidle")
    home.wait_for_timeout(800)
    home.screenshot(path=f"{SHOTS}/A-accueil.png")
    home.set_viewport_size({"width": 390, "height": 780})
    home.goto(BASE, wait_until="networkidle")
    home.wait_for_timeout(700)
    home.screenshot(path=f"{SHOTS}/B-accueil-mobile.png")
    home.close()

    # la conversation. L'anti-flood autorise 5 messages / 10 s par personne :
    # on laisse donc respirer, sinon la moitié serait refusée à juste titre.
    for pseudo, texte in CONVERSATION:
        p = pages[pseudo]
        p.fill("#input", texte)
        p.press("#input", "Enter")
        time.sleep(0.8)

    time.sleep(1.2)
    cam = pages["Camille"]
    cam.screenshot(path=f"{SHOTS}/C-salon.png")

    # « est en train d'écrire » visible chez Camille
    pages["Sofia"].fill("#input", "je cherche un bon resto sur Paris")
    time.sleep(0.8)
    cam.screenshot(path=f"{SHOTS}/D-ecriture.png")
    pages["Sofia"].fill("#input", "")

    # thème sombre
    jul = pages["Julien"]
    jul.click("#theme"); time.sleep(0.5)
    jul.screenshot(path=f"{SHOTS}/E-sombre.png")

    # message privé
    jul.click("#userList .user:has-text('Camille')")
    jul.wait_for_selector("#card:not([hidden])", timeout=6000)
    jul.screenshot(path=f"{SHOTS}/F-fiche.png")
    jul.click("#cardPm"); time.sleep(0.5)
    for t in ["Salut Camille, tu connais bien Toulouse ?",
              "Je dois y aller le mois prochain pour le travail"]:
        jul.fill("#input", t); jul.press("#input", "Enter"); time.sleep(0.8)
    time.sleep(0.8)
    cam.click("#tabs .tab:has-text('Julien')"); time.sleep(0.6)
    for t in ["Oui très bien, j'y habite depuis 8 ans !",
              "Dis-moi ce que tu cherches, je te donnerai des adresses 😊"]:
        cam.fill("#input", t); cam.press("#input", "Enter"); time.sleep(0.8)
    time.sleep(0.8)
    cam.screenshot(path=f"{SHOTS}/G-prive.png")
    jul.screenshot(path=f"{SHOTS}/H-prive-sombre.png")

    # mobile, avec la conversation en place
    mob = b.new_context(locale="fr-FR")
    m = entrer(mob, "Lea", 24, "f", "Normandie", 390, 780)
    time.sleep(1.0)
    m.screenshot(path=f"{SHOTS}/I-mobile.png")
    m.click("#openRooms"); time.sleep(0.5)
    m.screenshot(path=f"{SHOTS}/J-mobile-salons.png")
    m.click("#closeRooms"); time.sleep(0.4)
    m.click("#openUsers"); time.sleep(0.5)
    m.screenshot(path=f"{SHOTS}/K-mobile-connectes.png")

    # emojis
    m.click("#closeUsers"); time.sleep(0.3)
    m.click("#emojiBtn"); time.sleep(0.4)
    m.screenshot(path=f"{SHOTS}/L-mobile-emojis.png")

    b.close()

print("captures écrites dans", SHOTS)
