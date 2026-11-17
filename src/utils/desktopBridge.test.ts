import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The preload script is plain JS the type checker never sees, so its list must match DesktopBridge by hand.
const KEYS = [
  'isDesktop', 'pushState', 'setWidgets', 'onState', 'command', 'onCommand',
  'getUpdateState', 'checkForUpdates', 'installUpdate', 'onUpdateState', 'onFlush', 'flushed',
];

describe('preload parity', () => {
  const preload = readFileSync('electron/preload.cjs', 'utf8');
  const iface = readFileSync('src/utils/desktopBridge.ts', 'utf8');
  it.each(KEYS)('%s is in the preload and the interface', (k) => {
    expect(preload.includes(k)).toBe(true);
    expect(iface.includes(k)).toBe(true);
  });
  it('the preload exposes no key the list does not know', () => {
    const body = preload.slice(preload.indexOf('exposeInMainWorld'));
    const exposed = [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(exposed.sort()).toEqual([...KEYS].sort());
  });
});
