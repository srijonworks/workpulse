# WorkPulse desktop app (Windows)

The desktop app is the same WorkPulse in its own window. `electron/main.cjs` starts the bundled server (`server.ts`, bundled to
`electron/app/server.cjs` by `scripts/build-desktop.mjs`) on **127.0.0.1:38417** and opens `http://localhost:38417` in a window.

## Install
Run the newest `WorkPulse Setup <version>.exe` in `C:\Users\DELL\wp-release`. Windows may say "unknown publisher" (the app is not code-signed): More info, Run anyway.

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
   downloads the new version and asks **Restart now / Later**. **Restart now** installs silently (`quitAndInstall(true, true)`: no installer
   window, no admin prompt) and starts the app again. "Later" installs it the next time the app quits. Tray menu -> **Check for
   updates** checks at once. Your data stays.
- The installer is **one click and per user** (`nsis.oneClick`, `perMachine: false`): it installs to `%LOCALAPPDATA%\Programs\WorkPulse` with
  no admin rights, so later updates can be silent. An older all-users install (in `C:\Program Files`) needs a one-time switch: uninstall it,
  then run the new `WorkPulse Setup <version>.exe` once. Data is kept (it lives in `AppData\Roaming\WorkPulse` and the fixed port).
- The first installer that has the updater is 1.0.1 or newer: install it by hand once, the rest is one click.
- `npm run desktop:pack` makes only the unpacked folder (`wp-release\win-unpacked\WorkPulse.exe`) for a quick test.
- Build notes: `scripts/electron-builder.mjs` keeps its work folders in your home folder, not the repo: `~\wp-electron` (a copy of the
  Electron files, made by the script when it is missing or the Electron version changed) and `~\wp-release` (installer and update feed),
  because packing inside the repo failed with locked files.
- First time on a PC: `npm --prefix electron install`. npm 12 blocks Electron's download script unless it is approved: `electron/package.json`
  carries `allowScripts` for `electron@39.8.10`. If the binary is still missing (`electron/node_modules/electron/dist/electron.exe`), run
  `npm --prefix electron rebuild electron`, or `node electron/node_modules/electron/install.js`.
- The updater only works while `wp-release` exists on this PC. For other PCs the installers would have to be hosted (e.g. GitHub Releases).

## Staying alive and keeping data safe
- **One instance.** Starting WorkPulse a second time only brings the first window forward.
- **A crashed or frozen page comes back.** If the window's page crashes, it reloads after a short wait that grows each time. After several
  crashes in a row the app stops and says so (choose Quit in the tray, then open it again) instead of looping. A page that does not answer
  for 30 seconds is restarted, and a page that fails to load is tried again every 3 seconds.
- **A stray error does not end the day.** After start-up, an unexpected error in the main process is logged and the tray app keeps running.
  Before start-up the app shows why it cannot start, then quits.
- **Saving before it stops.** On quit, sleep, screen lock and sign-out the app asks the page to write everything it holds in memory
  (running timers, anything not saved yet) and waits up to 1.5 seconds, then flushes the browser storage to disk.
- **Start with Windows, hidden.** The login item starts WorkPulse with `--hidden`: it goes straight to the tray with no window. It is set
  once; a later choice in the tray menu is kept.
- **Copies and logs on disk.** `%USERPROFILE%\WorkPulse\backups\<app address>\` holds copies of your data (the page makes one a few seconds
  after a change; "Restore" offers them if the app's storage is ever wiped). `%USERPROFILE%\WorkPulse\logs\` holds a small log: what
  happened and where, never what you wrote. Settings -> System status shows how all of this is doing; see `docs/system-status.md`.
- **A test copy** does not touch the installed app: set `WORKPULSE_USER_DATA` (its own storage and single-instance lock) and, for another
  address, `WORKPULSE_TEST_PORT`; use `--data-dir=temp` or `WORKPULSE_DATA_DIR` for the server's folder.
