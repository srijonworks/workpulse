import { describe, it, expect } from 'vitest';
import { createScriptHarness } from '../../test/appsScriptHarness';
import { GOOGLE_APPS_SCRIPT_CODE } from '../googleAppsScriptTemplate';
import { PHONE_PAGE_HTML, SCRIPT_PHONE } from './phonePage';

// The page's own script (everything between <script> and </script>).
const pageScript = (PHONE_PAGE_HTML.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

describe('phone page HTML', () => {
  it('loads nothing from outside: no external scripts, styles, fonts or images', () => {
    expect(PHONE_PAGE_HTML).not.toMatch(/\b(src|href)\s*=\s*["']?\s*(https?:)?\/\//i);
    expect(PHONE_PAGE_HTML).not.toMatch(/@import|url\(\s*["']?(https?:)?\/\//i);
    expect(PHONE_PAGE_HTML).not.toMatch(/<link\b/i);
  });

  it('never writes markup from data: no innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    expect(pageScript.length).toBeGreaterThan(1000);
    expect(PHONE_PAGE_HTML).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(pageScript).toContain('textContent');
    expect(pageScript).toContain('createElement');
  });

  it('calls the three PIN-checked script functions through google.script.run', () => {
    expect(pageScript).toContain('google.script.run');
    expect(pageScript).toMatch(/\.phoneData\(/);
    expect(pageScript).toMatch(/\.phoneAddTask\(/);
    expect(pageScript).toMatch(/\.phoneAddLog\(/);
    expect(pageScript).toMatch(/\.phoneOlderLogs\(/);
  });

  it('keeps the PIN in localStorage only inside try/catch', () => {
    const uses = pageScript.match(/localStorage/g) || [];
    expect(uses.length).toBeGreaterThan(0);
    // Every storage access lives in the two guarded helpers.
    const guarded = pageScript.match(/try \{ ?(return )?window\.localStorage/g) || [];
    expect(guarded.length).toBe(uses.length);
  });

  it('is plain ES5 so it runs in old phone browsers and keeps the script ES5-clean', () => {
    expect(pageScript).not.toMatch(/\b(let|const)\s/);
    expect(pageScript).not.toMatch(/=>/);
    expect(PHONE_PAGE_HTML).not.toContain('`');
    expect(() => new Function(pageScript)).not.toThrow();
  });
});

describe('phone page in the script', () => {
  it('doGet?page=phone serves the page with the title and the viewport tag', () => {
    const h = createScriptHarness();
    const out = h.get({ page: 'phone' });
    expect(out.kind).toBe('html');
    expect(out.html).toBe(PHONE_PAGE_HTML);
    expect(out.title).toBe('WorkPulse');
    expect(out.metaTags).toContainEqual({ name: 'viewport', content: 'width=device-width, initial-scale=1' });
  });

  it('embeds the page as one JSON-escaped ASCII line, so no character can break the script string', () => {
    expect(SCRIPT_PHONE).toContain('function servePhonePage()');
    const line = SCRIPT_PHONE.split('\n').find((l) => l.startsWith('var PHONE_PAGE_HTML = '));
    expect(line).toBeDefined();
    expect(line!).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(line!.slice('var PHONE_PAGE_HTML = '.length).replace(/;$/, ''))).toBe(PHONE_PAGE_HTML);
    expect(GOOGLE_APPS_SCRIPT_CODE).toContain(SCRIPT_PHONE);
    expect(GOOGLE_APPS_SCRIPT_CODE.match(/^function servePhonePage\(/gm)).toHaveLength(1);
  });

  it('the whole script stays under 200 KB', () => {
    expect(new TextEncoder().encode(GOOGLE_APPS_SCRIPT_CODE).length).toBeLessThan(200 * 1024);
  });
});
