// Runs electron-builder for the desktop app with the work folders outside the repo (packing inside it
// failed with locked files): ~/wp-electron holds a copy of the Electron files, ~/wp-release gets the
// installer and the update feed. Usage: node scripts/electron-builder.mjs [--dir]
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const electronDir = path.join(root, 'electron');
const installed = path.join(electronDir, 'node_modules', 'electron', 'dist');
const electronDist = path.join(os.homedir(), 'wp-electron');
const output = path.join(os.homedir(), 'wp-release');
const forward = (p) => p.replace(/\\/g, '/');

const versionOf = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'version'), 'utf8').trim();
  } catch {
    return null;
  }
};

const wanted = versionOf(installed);
if (!wanted || !fs.existsSync(path.join(installed, 'electron.exe'))) {
  console.error('Electron is not installed. Run: npm --prefix electron install');
  process.exit(1);
}
if (versionOf(electronDist) !== wanted) {
  console.log(`Copying Electron ${wanted} to ${electronDist}`);
  fs.rmSync(electronDist, { recursive: true, force: true });
  fs.cpSync(installed, electronDist, { recursive: true });
}

const cli = createRequire(path.join(electronDir, 'package.json')).resolve('electron-builder/cli.js');
const args = [
  cli,
  '--win',
  ...process.argv.slice(2),
  `--config.electronDist=${forward(electronDist)}`,
  `--config.directories.output=${forward(output)}`,
];
const run = spawnSync(process.execPath, args, { cwd: electronDir, stdio: 'inherit' });
process.exit(run.status ?? 1);
