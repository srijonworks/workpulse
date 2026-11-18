"""How much main-thread time does the 1-second timer cost? Runs with a task timer going and reads
Chrome's own counters (script time and task time) over a fixed window, per theme (chase, timecard,
console) on the Today and Tasks screens. The sample data has one task running.

Usage (server already running):  python tests/smoke/tick_cost.py [--url URL] [--seconds 8]
Or with its own server:          python .claude/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3737 --timeout 60 -- python tests/smoke/tick_cost.py

Numbers are milliseconds of main-thread work per second of wall time. Compare before and after a
change on the same machine; the absolute values depend on the CPU. Always exits 0.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright
import smoke


def measure(page, seconds):
    cdp = page.context.new_cdp_session(page)
    cdp.send("Performance.enable")
    def snap():
        return {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
    page.wait_for_timeout(500)
    a = snap()
    page.wait_for_timeout(int(seconds * 1000))
    b = snap()
    return {k: (b[k] - a[k]) * 1000 / seconds for k in ("ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("WP_URL", "http://localhost:3737"))
    ap.add_argument("--seconds", type=float, default=8)
    a = ap.parse_args()
    print(f"{'theme/screen':24} {'script ms/s':>12} {'task ms/s':>10} {'layout':>8} {'style':>8}")
    with sync_playwright() as pw:
        for theme in smoke.THEMES:
            for tab in ("today", "tasks"):
                s = smoke.Session(pw, a.url, theme=theme)
                s.tab(tab)
                r = measure(s.page, a.seconds)
                print(f"{theme + '/' + tab:24} {r['ScriptDuration']:12.1f} {r['TaskDuration']:10.1f} {r['LayoutDuration']:8.1f} {r['RecalcStyleDuration']:8.1f}")
                s.close()


if __name__ == "__main__":
    main()
