import { describe, expect, it } from 'vitest';
import { isOurUrl, isSafeExternal } from './policy';

const ORIGIN = 'http://localhost:38417';

describe('isOurUrl', () => {
  it('accepts the app address and any page on it', () => {
    expect(isOurUrl('http://localhost:38417', ORIGIN)).toBe(true);
    expect(isOurUrl('http://localhost:38417/', ORIGIN)).toBe(true);
    expect(isOurUrl('http://localhost:38417/?widget=time', ORIGIN)).toBe(true);
  });
  it('refuses look-alike addresses that a plain startsWith check lets through', () => {
    expect(isOurUrl('http://localhost:38417@evil.example/', ORIGIN)).toBe(false);
    expect(isOurUrl('http://localhost:38417.evil.example/', ORIGIN)).toBe(false);
    expect(isOurUrl('http://localhost:384170/', ORIGIN)).toBe(false);
    expect(isOurUrl('https://localhost:38417/', ORIGIN)).toBe(false);
  });
  it('refuses another site, another port, and anything that is not a URL string', () => {
    expect(isOurUrl('https://web.whatsapp.com/send', ORIGIN)).toBe(false);
    expect(isOurUrl('http://localhost:3000/', ORIGIN)).toBe(false);
    expect(isOurUrl('not a url', ORIGIN)).toBe(false);
    expect(isOurUrl(undefined, ORIGIN)).toBe(false);
    expect(isOurUrl(42, ORIGIN)).toBe(false);
  });
});

describe('isSafeExternal', () => {
  it('allows web and mail links', () => {
    expect(isSafeExternal('https://web.whatsapp.com/send?text=hi')).toBe(true);
    expect(isSafeExternal('http://example.com/')).toBe(true);
    expect(isSafeExternal('mailto:me@example.com')).toBe(true);
  });
  it('blocks local files, program-launching schemes and scripts', () => {
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id PCWDiagnostic', 'javascript:alert(1)', 'data:text/html,hi', 'smb://host/share']) {
      expect(isSafeExternal(url)).toBe(false);
    }
  });
  it('blocks anything that is not a URL string', () => {
    expect(isSafeExternal('')).toBe(false);
    expect(isSafeExternal('C:\\Windows\\notepad.exe')).toBe(false);
    expect(isSafeExternal(null)).toBe(false);
  });
});
