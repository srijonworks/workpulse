import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { describeRouteError, installProcessGuards, jsonErrorHandler, listenErrorMessage } from './errors';

describe('describeRouteError', () => {
  it('says a too-large request is too large (413)', () => {
    expect(describeRouteError({ type: 'entity.too.large', status: 413 })).toEqual({ status: 413, error: 'That request was too large for WorkPulse to take.' });
  });
  it('says an unreadable body could not be read (400)', () => {
    expect(describeRouteError({ type: 'entity.parse.failed', status: 400 }).status).toBe(400);
  });
  it('keeps another 4xx status with a plain sentence', () => {
    expect(describeRouteError({ status: 415 })).toEqual({ status: 415, error: 'WorkPulse could not use that request.' });
  });
  it('hides everything else behind a plain 500', () => {
    for (const err of [new Error('ECONNRESET at C:\\secret\\path.js'), 'boom', null, undefined, { status: 'x' }]) {
      const r = describeRouteError(err);
      expect(r.status).toBe(500);
      expect(r.error).not.toMatch(/secret|ECONNRESET|boom/);
    }
  });
});

describe('listenErrorMessage', () => {
  it('names the busy port in plain words', () => {
    expect(listenErrorMessage({ code: 'EADDRINUSE' }, 38417)).toBe(
      'Port 38417 is already in use. Close the other program using it (or another copy of WorkPulse) and start again.',
    );
  });
  it('covers a refused port and anything else', () => {
    expect(listenErrorMessage({ code: 'EACCES' }, 80)).toMatch(/not allowed to use port 80/);
    expect(listenErrorMessage({ code: 'EOTHER', message: 'odd' }, 1)).toMatch(/could not start its server: odd/);
  });
});

describe('installProcessGuards', () => {
  it('logs an unhandled rejection instead of leaving it to end the process', () => {
    const handlers: Record<string, (r: unknown) => void> = {};
    const log = vi.fn();
    installProcessGuards({ on: ((event: string, fn: (r: unknown) => void) => { handlers[event] = fn; }) as never }, log);
    expect(handlers.unhandledRejection).toBeTypeOf('function');
    handlers.unhandledRejection(new Error('late failure'));
    expect(log).toHaveBeenCalledWith('WorkPulse unhandled rejection:', 'late failure');
  });
});

// The real thing, end to end: a real express app and real HTTP requests.
describe('jsonErrorHandler in an express app', () => {
  const start = async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/echo', (req, res) => res.json(req.body));
    app.get('/boom', () => {
      throw new Error('internal detail that must not leak');
    });
    app.use(jsonErrorHandler);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };
  const post = (port: number, body: string) =>
    fetch(`http://127.0.0.1:${port}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  it('answers an oversized body with JSON and a plain sentence, not an HTML page', async () => {
    const s = await start();
    try {
      const res = await post(s.port, JSON.stringify({ text: 'x'.repeat(5000) }));
      expect(res.status).toBe(413);
      expect(res.headers.get('content-type')).toMatch(/json/);
      expect((await res.json()).error).toMatch(/too large/);
    } finally {
      await s.close();
    }
  });
  it('answers a malformed body with JSON (400)', async () => {
    const s = await start();
    try {
      const res = await post(s.port, '{not json');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/could not read/);
    } finally {
      await s.close();
    }
  });
  it('answers a thrown error with a plain 500 and never leaks the detail', async () => {
    const s = await start();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/boom`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('internal detail');
      expect(JSON.parse(text).error).toMatch(/unexpected problem/);
    } finally {
      spy.mockRestore();
      await s.close();
    }
  });
});
