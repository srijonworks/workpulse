import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Points the home folder and WorkPulse's data folder at a fresh temp folder for every test file, so a test can
// never read or write the real ~/.claude, ~/.codex, OpenCode data or ~/WorkPulse. isolation.test.ts fails if
// this stops working.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workpulse-test-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.WORKPULSE_DATA_DIR = path.join(root, 'WorkPulse');

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // a leftover temp folder is harmless
  }
});
