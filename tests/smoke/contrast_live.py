"""Live contrast scan: every visible text element, per theme x mode x tab.

For each element that directly holds text, it composites the real computed background
(walking up the ancestors) and the computed text colour, and reports elements below WCAG AA
(4.5:1, or 3:1 for large text: >=24px, or >=18.66px and bold).

Usage (server already running):  python tests/smoke/contrast_live.py [--url URL] [--json OUT] [--tabs feed,backlog] [--verbose]
Or with its own server:          python .claude/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 3737 --timeout 60 -- python tests/smoke/contrast_live.py

It is a regression gate, not a verdict: it cannot see text over gradients or images, and
it counts each failing element once. Exit code is always 0; read the numbers.
"""
import argparse, io, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright
import smoke  # reuses Session, THEMES, SEL (also installs the UTF-8 stdout wrapper)

SCAN_JS = r"""
() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', {willReadFrequently:true});
  const parse = (c) => { if (!c || c==='transparent') return {r:0,g:0,b:0,a:0};
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}; }
    // oklab(), color(srgb ...), color-mix(): let the browser convert it
    cx.clearRect(0,0,1,1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0,0,1,1);
    const d = cx.getImageData(0,0,1,1).data; return {r:d[0],g:d[1],b:d[2],a:d[3]/255}; };
  const over = (f,b) => ({r:f.r*f.a+b.r*(1-f.a), g:f.g*f.a+b.g*(1-f.a), b:f.b*f.a+b.b*(1-f.a), a:1});
  const lum = (c) => { const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}; return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
  const ratio = (a,b) => { const x=lum(a), y=lum(b); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); };
  const bgOf = (el) => { const stack=[]; for (let e=el; e; e=e.parentElement) { const cs0=getComputedStyle(e); if ((cs0.backgroundImage||'').includes('gradient')) return null;
      const c=parse(cs0.backgroundColor); if (c && c.a>0) stack.push(c); if (c && c.a>=1) break; }
    let base = {r:255,g:255,b:255,a:1}; const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    if (!stack.length || stack[stack.length-1].a<1) base = (bodyBg && bodyBg.a>0)? over(bodyBg,{r:255,g:255,b:255,a:1}) : base;
    let out = base; for (let i=stack.length-1;i>=0;i--) out = over(stack[i], out); return out; };
  const opacityOf = (el) => { let o=1; for (let e=el;e;e=e.parentElement) o*=parseFloat(getComputedStyle(e).opacity); return o; };
  const res = []; const seen = new Set();
  document.querySelectorAll('body *').forEach(el => {
    if (['SCRIPT','STYLE','NOSCRIPT','SVG','PATH'].includes(el.tagName.toUpperCase())) return;
    let txt = ''; el.childNodes.forEach(n => { if (n.nodeType===3) txt += n.textContent; });
    if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') txt = (el.value||'')||'';
    txt = txt.replace(/\s+/g,' ').trim(); const isPh = !txt && el.placeholder; if (isPh) txt = el.placeholder;
    if (!txt) return;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (r.width<2||r.height<2||cs.visibility==='hidden'||cs.display==='none') return;
    if (r.bottom<0||r.right<0) return;
    if (el.tagName==='OPTION') return;
    if (el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled')) { window.__exempt=(window.__exempt||0)+1; return; }
    let fg = parse(isPh ? getComputedStyle(el,'::placeholder').color : cs.color); if (!fg) return;
    const op = opacityOf(el); if (op < 0.1) return; const bg = bgOf(el); if (!bg) { window.__skipped=(window.__skipped||0)+1; return; } fg = over({...fg, a: fg.a*op}, bg);
    const px = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight)>=700;
    const large = px>=24 || (px>=18.66 && bold); const need = large?3:4.5; const cr = ratio(fg,bg);
    if (cr < need) { const key = el.className+'|'+txt.slice(0,20); if (seen.has(key)) return; seen.add(key);
      res.push({text: txt.slice(0,40), ratio: Math.round(cr*100)/100, need, px, cls: (typeof el.className==='string'?el.className:'').slice(0,90)}); }
  });
  return res;
}
"""
SKIPPED_JS = "() => { const n = window.__skipped||0; window.__skipped = 0; return n; }"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("WP_URL", "http://localhost:3737"))
    ap.add_argument("--json", default="")
    ap.add_argument("--tabs", default="feed,backlog,analytics,settings")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    tabs = [t for t in a.tabs.split(",") if t]
    combos = [("modern", "dark"), ("modern", "light"), ("minimalist", "light"), ("minimalist", "dark"),
              ("compact", "dark"), ("compact", "light"), ("matrix", "dark")]
    report, total = {}, 0
    with sync_playwright() as pw:
        for theme, mode in combos:
            s = smoke.Session(pw, a.url, theme=theme, mode=mode)
            for tab in tabs:
                s.tab(tab)
                s.page.wait_for_timeout(250)
                s.page.evaluate("window.__skipped = 0")
                bad = s.page.evaluate(SCAN_JS)
                skipped = s.page.evaluate(SKIPPED_JS)
                key = f"{theme}/{mode}/{tab}"
                report[key] = bad
                total += len(bad)
                worst = sorted(bad, key=lambda x: x["ratio"])[:3]
                print(f"{key:28} {len(bad):3} below AA ({skipped} on gradients, not measured)" + ("   e.g. " + "; ".join(f'"{w["text"][:22]}" {w["ratio"]}' for w in worst) if worst else ""))
                if a.verbose:
                    for w in sorted(bad, key=lambda x: x["ratio"]):
                        print(f"      {w['ratio']:>5} (need {w['need']}) {w['px']}px  \"{w['text']}\"  .{w['cls'][:70]}")
            s.close()
    print(f"\nTOTAL elements below AA across {len(report)} screens: {total}")
    if a.json:
        json.dump(report, open(a.json, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
