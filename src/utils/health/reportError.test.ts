import { describe, expect, it, vi } from 'vitest';
import { crashReloadDecision, createErrorReporter, installGlobalErrorHandlers, resetKeysChanged } from './reportError';

describe('createErrorReporter', () => {
  it('reports an error with its area, a fixed sentence and a redacted detail', () => {
    const report = vi.fn();
    createErrorReporter({ report })('History', new Error('boom for owner@example.org'));
    expect(report).toHaveBeenCalledWith({
      area: 'History',
      message: 'A part of WorkPulse (History) ran into a problem.',
      detail: 'boom for o***@example.org',
    });
  });

  it('reports the same error once, even if it repeats in a render loop', () => {
    const report = vi.fn();
    const r = createErrorReporter({ report });
    const err = new Error('same');
    for (let i = 0; i < 50; i++) r('Tasks', err);
    expect(report).toHaveBeenCalledTimes(1);
    r('Tasks', new Error('different'));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('stops after the limit for one session', () => {
    const report = vi.fn();
    const r = createErrorReporter({ report, max: 3 });
    for (let i = 0; i < 10; i++) r('A', new Error(`e${i}`));
    expect(report).toHaveBeenCalledTimes(3);
  });

  it('never throws, even if the reporting itself does', () => {
    const r = createErrorReporter({
      report: () => {
        throw new Error('log is broken');
      },
    });
    expect(() => r('A', 'text error')).not.toThrow();
    expect(() => r('A', undefined)).not.toThrow();
  });
});

describe('resetKeysChanged', () => {
  it('is false for the same keys and true when one changes or the count differs', () => {
    expect(resetKeysChanged(['today'], ['today'])).toBe(false);
    expect(resetKeysChanged(undefined, [])).toBe(false);
    expect(resetKeysChanged(['today'], ['tasks'])).toBe(true);
    expect(resetKeysChanged([], ['tasks'])).toBe(true);
  });
});

describe('installGlobalErrorHandlers', () => {
  it('reports a script error and a rejected promise, and nothing else', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const target = { addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; } };
    const report = vi.fn();
    installGlobalErrorHandlers(target as never, report);
    handlers.error({ error: new Error('script boom'), message: 'script boom' });
    handlers.error({ message: 'Script error.' });
    handlers.unhandledrejection({ reason: new Error('late') });
    expect(report).toHaveBeenNthCalledWith(1, 'window', expect.any(Error));
    expect(report).toHaveBeenNthCalledWith(2, 'window', 'Script error.');
    expect(report).toHaveBeenNthCalledWith(3, 'promise', expect.any(Error));
    expect(Object.keys(handlers).sort()).toEqual(['error', 'unhandledrejection']);
  });

  it('ignores the harmless ResizeObserver notice the browser raises all the time', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const target = { addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; } };
    const report = vi.fn();
    installGlobalErrorHandlers(target as never, report);
    handlers.error({ message: 'ResizeObserver loop completed with undelivered notifications.' });
    handlers.error({ message: 'ResizeObserver loop limit exceeded' });
    expect(report).not.toHaveBeenCalled();
  });
});

describe('crashReloadDecision', () => {
  it('allows the first reload', () => {
    expect(crashReloadDecision({ now: 1000, lastReloadAt: null })).toBe(true);
  });
  it('does not reload again within five minutes, so a crash on every start does not loop', () => {
    expect(crashReloadDecision({ now: 1_000_000 + 4 * 60_000, lastReloadAt: 1_000_000 })).toBe(false);
    expect(crashReloadDecision({ now: 1_000_000 + 5 * 60_000, lastReloadAt: 1_000_000 })).toBe(true);
  });
});
