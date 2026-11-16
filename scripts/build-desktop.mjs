// Prepares electron/app: the built page (dist/), the server bundled into one file, and the shell's logic bundled into another.
import { build } from 'esbuild';
import fs from 'node:fs';

fs.rmSync('electron/app', { recursive: true, force: true });
fs.mkdirSync('electron/app', { recursive: true });
fs.cpSync('dist', 'electron/app/dist', { recursive: true });

await build({
  entryPoints: ['server.ts'],
  outfile: 'electron/app/server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vite'],
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  logLevel: 'info',
});

// The shell's own decisions (src/shell), loaded by electron/main.cjs.
await build({
  entryPoints: ['src/shell/index.ts'],
  outfile: 'electron/app/shell.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'info',
});
