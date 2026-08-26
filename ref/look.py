from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width":1280,"height":800}, locale="fr-FR",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
    pg = ctx.new_page()
    for name,url in [("home","https://chatnow.fr/"),("chat","https://chatnow.fr/chat")]:
        try:
            r = pg.goto(url, wait_until="networkidle", timeout=45000)
            print(name, r.status if r else "?")
            pg.screenshot(path=f"{name}.png")
            open(f"{name}.txt","w").write(pg.inner_text("body")[:6000])
        except Exception as e:
            print(name, "ERR", e)
    b.close()
