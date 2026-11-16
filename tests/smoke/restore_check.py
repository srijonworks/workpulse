import glob, json, os, sys, tempfile
from playwright.sync_api import sync_playwright

URL = "http://localhost:3000/"
ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra)
    ok = ok and cond

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page()
    page.goto(URL)
    page.wait_for_timeout(1500)
    box = page.get_by_role("combobox", name="What did you just finish?")
    box.fill("Restore check real log")
    box.press("Enter")
    page.wait_for_timeout(500)
    # copy is written ~3 s later
    page.wait_for_timeout(22000)
    r = page.evaluate("fetch('/api/disk-copy').then(r=>r.json())")
    copy = r.get("copy")
    check("copy written to disk", bool(copy) and copy["counts"]["logs"] >= 1, str(copy and copy["counts"]))

    # wipe the browser's storage
    page.close()
    page = b.new_context().new_page()  # a browser profile with nothing in it
    page.goto(URL)
    page.wait_for_timeout(2500)
    banner = page.get_by_test_id("disk-copy")
    check("restore offer shown", banner.count() == 1 and "copy" in banner.inner_text().lower(), banner.inner_text() if banner.count() else "")
    page.get_by_role("button", name="Restore my data").click()
    page.wait_for_timeout(3000)
    logs = page.evaluate("localStorage.getItem('workpulse_logs')")
    check("log is back after restore", logs is not None and "Restore check real log" in logs)
    check("offer gone after restore", page.get_by_test_id("disk-copy").count() == 0)
    b.close()

sys.exit(0 if ok else 1)
