"""End-to-end test: drives the real page against test/e2e/server.mjs.

Run: node test/e2e/server.mjs &  then  python3 test/e2e/run.py [screenshot_dir]
"""
import sys, time, os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://localhost:8788")
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
results = []

def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name)

def wait_for(page, js, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate(js):
            return True
        time.sleep(0.1)
    return False

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="fr-FR")
    page = ctx.new_page()
    errors = []
    IGNORED = ("ERR_TUNNEL_CONNECTION_FAILED", "status of 401")  # fonts offline in the sandbox; the wrong-code test
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and not any(x in m.text for x in IGNORED) else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/")

    # Access code dialog
    check("access dialog opens", wait_for(page, "document.querySelector('#access').open"))
    page.fill("#access-input", "wrong")
    page.click("#access-form button[type=submit]")
    check("wrong code is refused", wait_for(page, "!document.querySelector('#access-error').hidden"))
    page.fill("#access-input", "nexa2026")
    page.click("#access-form button[type=submit]")
    check("right code closes dialog", wait_for(page, "!document.querySelector('#access').open"))
    check("index built with vectors", wait_for(page, "document.querySelector('#status').classList.contains('ok')", 20))
    status = page.text_content("#status")
    check("status shows passages count: " + status, "passages" in status)
    if SHOTS: page.screenshot(path=f"{SHOTS}/1-home.png")

    # Ask with a suggestion (télétravail paraphrase)
    page.click("[data-suggest='1']")
    check("answer appears", wait_for(page, "!document.querySelector('#answer').hidden && document.querySelector('#answer-body').textContent.length > 20", 20))
    check("citations rendered as buttons", page.locator("#answer-body button.cite").count() >= 2)
    check("five sources", page.locator("#source-list > li").count() == 5)
    check("trace has rank rows", page.locator(".rankflow .rf-row").count() == 6)
    check("latency bar has segments incl. answer", page.locator(".lat-bar .s-answer").count() == 1)
    check("top source is télétravail section", "Télétravail" in page.text_content("#src-1 .src-title"))
    check("query terms highlighted", page.locator("#src-1 mark").count() > 0)
    check("no invented citation flagged", page.locator(".meta-item.good").count() == 1)
    widths = page.evaluate("[...document.querySelectorAll('.lat-bar .seg')].map(s => s.style.width)")
    check("latency widths applied via CSSOM", all(w.endswith('%') for w in widths))
    if SHOTS: page.screenshot(path=f"{SHOTS}/2-answer.png", full_page=True)

    # Citation click flashes the source
    page.click("#answer-body button.cite >> nth=0")
    check("citation click flashes source", wait_for(page, "document.querySelector('#src-1').classList.contains('flash')"))

    # Switch mode: BM25 only
    page.click("[data-mode='bm25']")
    check("bm25 mode re-runs and trace shows only BM25 ranks", wait_for(page, "document.querySelector('.trace-mode') && document.querySelector('.trace-mode').textContent.includes('BM25') && document.querySelectorAll('.rankflow .rf-row:not(.rf-head) .rf-cell.off').length === 15", 15))
    page.click("[data-mode='rerank']")
    wait_for(page, "document.querySelectorAll('.rankflow .rf-cell.off').length === 0", 15)

    # Unanswerable question
    page.fill("#q", "Quel est le salaire d'un développeur junior ?")
    page.press("#q", "Enter")
    check("not-found answer shown", wait_for(page, "document.querySelector('#answer-body').textContent.includes('Je ne trouve pas')", 15))

    # Language switch
    page.click(".lang button[data-lang='en']")
    check("English UI", page.text_content(".tab[data-view='ask']") == "Ask" and page.evaluate("document.documentElement.lang") == "en")
    page.click(".lang button[data-lang='fr']")

    # Library: inspector and poisoned document
    page.click(".tab[data-view='library']")
    page.click("[data-doc='02-procedure-facturation-relance']")
    check("inspector shows chunks", page.locator("#inspector .chunk").count() >= 4)
    before = int(page.evaluate("document.querySelectorAll('#index-stats b')[1].textContent"))
    page.select_option("#chunk-size", "300")
    page.click("#rebuild-btn")
    check(f"rebuild at 300 increases passages (from {before})", wait_for(page, f"Number(document.querySelectorAll('#index-stats b')[1].textContent) > {before}", 20))
    check("overlap shaded in inspector", wait_for(page, "document.querySelectorAll('#inspector .ov').length > 0", 5))
    if SHOTS: page.screenshot(path=f"{SHOTS}/3-library.png", full_page=False)
    page.click("#poison-btn")
    check("poisoned doc added", wait_for(page, "!!document.querySelector(\"[data-doc='zz-note-fournisseur-piegee']\")", 20))
    page.click("[data-remove='zz-note-fournisseur-piegee']")
    check("poisoned doc removed", wait_for(page, "!document.querySelector(\"[data-doc='zz-note-fournisseur-piegee']\")", 20))
    page.select_option("#chunk-size", "600")
    page.click("#rebuild-btn")
    wait_for(page, "document.querySelector('#status').classList.contains('ok')", 20)

    # Upload a text file
    page.set_input_files("#file-input", files=[{"name": "parking.md", "mimeType": "text/markdown", "buffer": "# Parking\n\n## Vélos\n\nLe local vélo est au sous-sol, badge zorglub requis pour entrer.".encode()}])
    check("uploaded file indexed", wait_for(page, "[...document.querySelectorAll('.doc-title')].some(e => e.textContent === 'Parking')", 20))

    # Evaluation
    page.click(".tab[data-view='eval']")
    page.click("#eval-btn")
    check("evaluation table with 4 methods", wait_for(page, "document.querySelectorAll('.metrics tbody tr').length === 4", 30))
    check("per-question table has 24 rows", page.locator(".perq tbody tr").count() == 24)
    check("three question types", page.locator(".type-group").count() == 3)
    check("CSV export enabled", page.is_enabled("#csv-btn"))
    with page.expect_download() as dl:
        page.click("#csv-btn")
    check("CSV downloads", dl.value.suggested_filename == "verity-evaluation.csv")
    if SHOTS: page.screenshot(path=f"{SHOTS}/4-eval.png", full_page=True)

    page.click(".tab[data-view='how']")
    if SHOTS: page.screenshot(path=f"{SHOTS}/5-how.png", full_page=True)

    # Mobile layout: no horizontal scroll
    m = browser.new_context(viewport={"width": 390, "height": 844}, locale="en-US")
    mp = m.new_page()
    mp.goto(BASE + "/")
    wait_for(mp, "document.querySelector('#access').open")
    mp.fill("#access-input", "nexa2026")
    mp.click("#access-form button[type=submit]")
    wait_for(mp, "document.querySelector('#status').classList.contains('ok')", 20)
    mp.click("[data-suggest='0']")
    wait_for(mp, "!document.querySelector('#answer').hidden", 20)
    check("mobile: no horizontal overflow", mp.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
    if SHOTS: mp.screenshot(path=f"{SHOTS}/6-mobile.png", full_page=True)

    check("no console errors: " + "; ".join(errors[:3]), not errors)
    browser.close()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
