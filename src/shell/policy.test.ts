import { describe, expect, it } from 'vitest';
import { crashDecision, isHiddenStart, isOurUrl, isSafeExternal } from './policy';

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

describe('crashDecision', () => {
  const now = 1_000_000;
  it('reloads after a growing wait', () => {
    expect(crashDecision([], now)).toEqual({ action: 'reload', delayMs: 1_000 });
    expect(crashDecision([now - 10_000], now)).toEqual({ action: 'reload', delayMs: 5_000 });
    expect(crashDecision([now - 20_000, now - 10_000], now)).toEqual({ action: 'reload', delayMs: 15_000 });
  });
  it('gives up on the fourth crash within five minutes', () => {
    expect(crashDecision([now - 30_000, now - 20_000, now - 10_000], now)).toEqual({ action: 'give-up' });
  });
  it('forgets crashes older than five minutes', () => {
    expect(crashDecision([now - 400_000, now - 380_000, now - 360_000], now)).toEqual({ action: 'reload', delayMs: 1_000 });
  });
});

describe('isHiddenStart', () => {
  it('is true only with the --hidden argument', () => {
    expect(isHiddenStart(['WorkPulse.exe', '--hidden'])).toBe(true);
    expect(isHiddenStart(['WorkPulse.exe'])).toBe(false);
  });
});
