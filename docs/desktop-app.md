# WorkPulse desktop app (Windows)

The desktop app is the same WorkPulse in its own window. `electron/main.cjs` starts the bundled server (`server.ts`, bundled to
`electron/app/server.cjs` by `scripts/build-desktop.mjs`) on **127.0.0.1:38417** and opens `http://localhost:38417` in a window.

## Install
Run `C:\Users\DELL\wp-release\WorkPulse Setup 1.0.0.exe`. Windows may say "unknown publisher" (the app is not code-signed): More info, Run anyway.

## Use
- Closing the window hides WorkPulse to the tray (timers keep running). Tray icon: Open, **Start with Windows**, Quit.
- Links to other sites (WhatsApp Web) open in your normal browser, where WhatsApp is logged in.
- Needs Claude Code installed and signed in on the PC for the Claude-written suggestions, as before.
- **Your data lives in the app's own storage** (`%APPDATA%\WorkPulse`), separate from the browser version. Move it once: browser version
  Settings -> Data & backup -> Back up now, then in the desktop app Import (or Restore from the Sheet). Updates keep the data, because the
  port (38417) never changes. Do not change it.

## Changing the app later (one click)
1. Change the code as usual and test it with `npm run dev`.
2. Run `npm run desktop:build`. It builds the page, bundles the server, raises the version (1.0.1, 1.0.2, ...) and writes the installer
   plus `latest.yml` into `~\wp-release` (`C:\Users\DELL\wp-release` here).
3. The installed app checks that folder when it starts and every 30 minutes (a tiny server on 127.0.0.1:38418 serves it, only on this PC),
   downloads the new version and asks **Restart now / Later**. "Later" installs it the next time the app quits. Tray menu -> **Check for
   updates** checks at once. Your data stays.
- The first installer that has the updater is 1.0.1 or newer: install it by hand once, the rest is one click.
- `npm run desktop:pack` makes only the unpacked folder (`wp-release\win-unpacked\WorkPulse.exe`) for a quick test.
- Build notes: `scripts/electron-builder.mjs` keeps its work folders in your home folder, not the repo: `~\wp-electron` (a copy of the
  Electron files, made by the script when it is missing or the Electron version changed) and `~\wp-release` (installer and update feed),
  because packing inside the repo failed with locked files.
- First time on a PC: `npm --prefix electron install`. npm 12 blocks Electron's download script unless it is approved: `electron/package.json`
  carries `allowScripts` for `electron@39.8.10`. If the binary is still missing (`electron/node_modules/electron/dist/electron.exe`), run
  `npm --prefix electron rebuild electron`, or `node electron/node_modules/electron/install.js`.
- The updater only works while `wp-release` exists on this PC. For other PCs the installers would have to be hosted (e.g. GitHub Releases).
