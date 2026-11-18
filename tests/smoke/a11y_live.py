"""Live accessibility scan per theme x mode x tab (desktop and mobile width).

Reports, for every visible interactive element:
  unnamed      no accessible name (aria-label, labelledby, <label>, text, title, alt)
  placeholder  named only by its placeholder (disappears once typed in)
  small        hit area under 24x24 CSS px (WCAG 2.2 AA 2.5.8)
  touch        mobile only: 24-43 px, passes AA but is below the 44 px comfortable touch size
  mouse-only   cursor:pointer but not focusable and not inside a control (unreachable by keyboard)
  no-focus     Tab lands on it and nothing visible changes (no outline, ring, border or fill change)

Usage (server already running):  python tests/smoke/a11y_live.py [--url URL] [--json OUT] [--verbose] [--no-focus]
Or with its own server:          python .claude/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3737 --timeout 60 -- python tests/smoke/a11y_live.py

A regression gate, not a verdict: automated checks catch about a third of real problems.
Exit code is always 0; read the numbers.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright
import smoke

STATIC_JS = r"""
(coarse) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[aria-hidden="true"]') && !el.closest('[inert]'); };
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => {
    const al = el.getAttribute('aria-label'); if (al && al.trim()) return {n: al.trim(), via: 'aria-label'};
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim(); if (t) return {n: t, via: 'labelledby'}; }
    if (el.labels && el.labels.length) { const t = [...el.labels].map(text).join(' ').trim(); if (t) return {n: t, via: 'label'}; }
    if (el.tagName === 'INPUT' && ['button','submit','reset'].includes(el.type) && el.value) return {n: el.value, via: 'value'};
    const t = text(el); if (t) return {n: t, via: 'text'};
    const img = el.querySelector('img[alt]'); if (img && img.alt.trim()) return {n: img.alt.trim(), via: 'alt'};
    const ti = el.getAttribute('title'); if (ti && ti.trim()) return {n: ti.trim(), via: 'title'};
    if (el.placeholder) return {n: el.placeholder, via: 'placeholder'};
    return {n: '', via: ''};
  };
  const desc = (el) => { const r = el.getBoundingClientRect();
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(c => c && !c.startsWith('hover:') && !c.startsWith('focus')).slice(0, 4).join(' ');
    return `${el.tagName.toLowerCase()}${el.type && el.tagName==='INPUT' ? '['+el.type+']' : ''} ${Math.round(r.width)}x${Math.round(r.height)} .${cls}`; };
  const out = {unnamed: [], placeholder: [], small: [], touch: [], mouseOnly: []};
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=radio], [role=checkbox], [role=switch], [tabindex]:not([tabindex="-1"])';
  const els = [...document.querySelectorAll(SEL)].filter(vis);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const nm = nameOf(el);
    if (!nm.n) out.unnamed.push(desc(el));
    else if (nm.via === 'placeholder') out.placeholder.push(desc(el) + ' "' + nm.n.slice(0, 30) + '"');
    const isTextInput = el.tagName === 'INPUT' && ['checkbox','radio'].includes(el.type) === false;
    // checkboxes and radios are small by nature; their label is the target
    if ((el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels.length) continue;
    if (el.disabled) continue;
    if (r.width < 23.5 || r.height < 23.5) out.small.push(desc(el) + (nm.n ? ' "' + nm.n.slice(0, 24) + '"' : ''));
    else if (coarse && (r.width < 43.5 || r.height < 43.5)) out.touch.push(desc(el) + (nm.n ? ' "' + nm.n.slice(0, 24) + '"' : ''));
  }
  const interactive = new Set(els);
  document.querySelectorAll('body *').forEach(el => {
    if (!vis(el) || interactive.has(el)) return;
    if (getComputedStyle(el).cursor !== 'pointer') return;
    if (el.closest('button, a[href], label, select, summary, [role=button], [role=tab], [role=radio], [tabindex]:not([tabindex="-1"])')) return;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
    // report the outermost pointer element only
    const p = el.parentElement; if (p && getComputedStyle(p).cursor === 'pointer' && vis(p)) return;
    out.mouseOnly.push(desc(el) + ' "' + text(el).slice(0, 24) + '"');
  });
  return out;
}
"""

FOCUS_STATE_JS = r"""
() => { const el = document.activeElement; if (!el || el === document.body) return null;
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  return { sig: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderTopColor, cs.borderBottomColor, cs.backgroundColor, cs.color, cs.textDecorationLine].join('|'),
           outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
           tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 28),
           cls: (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 3).join(' '),
           vis: r.width > 0 && r.height > 0 }; }
"""


def focus_walk(page, limit=70):
    """Tab through the page; flag elements whose focused state looks identical to... a non-focused sibling state.
    We compare against the same element's style after blur()."""
    bad, seen = [], set()
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.mouse.move(0, 0)
    for _ in range(limit):
        page.keyboard.press("Tab")
        st = page.evaluate(FOCUS_STATE_JS)
        if not st:
            break
        key = (st["tag"], st["label"], st["cls"])
        if key in seen:
            break  # wrapped around
        seen.add(key)
        if not st["vis"]:
            continue
        if st["outline"]:
            continue
        # no outline: compare with the blurred look
        page.evaluate("document.activeElement.__wp = document.activeElement")
        blurred = page.evaluate("() => { const el = document.activeElement; el.blur(); const cs = getComputedStyle(el); const s = [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderTopColor, cs.borderBottomColor, cs.backgroundColor, cs.color, cs.textDecorationLine].join('|'); el.focus({focusVisible: true}); return s; }")
        if blurred == st["sig"]:
            bad.append(f'{st["tag"]} "{st["label"]}" .{st["cls"]}')
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("WP_URL", "http://localhost:3737"))
    ap.add_argument("--json", default="")
    ap.add_argument("--tabs", default="feed,backlog,analytics,settings")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--no-focus", action="store_true")
    a = ap.parse_args()
    tabs = [t for t in a.tabs.split(",") if t]
    combos = [("modern", "dark"), ("modern", "light"), ("minimalist", "light"), ("minimalist", "dark"),
              ("compact", "dark"), ("compact", "light"), ("matrix", "dark")]
    totals = {"unnamed": 0, "placeholder": 0, "small": 0, "touch": 0, "mouseOnly": 0, "noFocus": 0}
    report = {}
    with sync_playwright() as pw:
        for width, label in ((1440, "desktop"), (390, "mobile")):
            for theme, mode in combos:
                if label == "mobile" and mode == "light" and theme != "modern":
                    continue  # mobile layout is shared; sample modern light and the other three
                s = smoke.Session(pw, a.url, theme=theme, mode=mode, width=width, height=900 if width > 600 else 844, touch=width < 600)
                for tab in tabs:
                    s.tab(tab)
                    s.page.wait_for_timeout(250)
                    r = s.page.evaluate(STATIC_JS, width < 600)
                    r["noFocus"] = [] if (a.no_focus or width < 600) else focus_walk(s.page)
                    key = f"{label}/{theme}/{mode}/{tab}"
                    report[key] = r
                    for k in totals:
                        totals[k] += len(r[k])
                    print(f"{key:30} unnamed {len(r['unnamed']):3}  placeholder {len(r['placeholder']):3}  small {len(r['small']):3}  touch {len(r['touch']):3}  mouse-only {len(r['mouseOnly']):3}  no-focus {len(r['noFocus']):3}")
                    if a.verbose:
                        for k in ("unnamed", "placeholder", "small", "touch", "mouseOnly", "noFocus"):
                            for line in r[k]:
                                print(f"     {k:11} {line}")
                s.close()
    print("\nTOTALS", json.dumps(totals))
    if a.json:
        json.dump(report, open(a.json, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
