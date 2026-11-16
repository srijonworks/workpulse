# Handoff — 2026-11-16 · branch `main`

## Done
- Stages 0, 1.1 to 1.4 (see `C:\Users\DELL\.claude\plans\precious-sauteeing-origami.md`): toolchain, crash fixes, network layer, save engine + banner, error boundaries, health, log file.
- Stage 1.5 (disk copies), mostly: `src/server/localCopy.ts` (atomic, checksummed, prev/daily 14/safety 10), routes `GET/PUT /api/disk-copy` and `POST /api/disk-copy/safety` in `server.ts`, `src/utils/persist/diskMirror.ts` (debounced send), `reconcile.ts` (`decide`), `src/hooks/useDiskCopy.ts`, `src/components/DiskCopyBanner.tsx`, wired in `App.tsx`; safety copy before import and before restore.
- Verified: lint clean, 881 unit tests, smoke 48/48, `tests/smoke/restore_check.py` (wipe profile → offer → restore) passes. Nothing committed.

## Pending
- Stage 1.5 leftovers (safety copies before Reset / Start fresh / Fix dates are now done): Electron `will-download` reporting; list copies from other origins (Stage 6); add `restore_check` to `npm run test:smoke`.
- Stage 2 first part done: `src/utils/heartbeat.ts` (`gapDecision`), `src/hooks/useHeartbeat.ts` wired in App (writes `workpulse_heartbeat` every 30 s). Not yet used: the "Timer paused 47 min · Add it back" prompt (needs power events from Electron), and the day-close reading the beat.
- Data doctor done: `src/utils/dataDoctor.ts` (`repairData`, `recordRepairs`), runs at load in App (skipped while a list is blocked), toast + `workpulse_repairs`. Not yet run after import/restore (they reload, so load covers it). Unit 894, smoke 48/48 (one flaky `sheet_backup` navigation failure seen once, passed on rerun).
- Committed `8ebc2a6` (stages 1 to heartbeat + data doctor). Uncommitted since: Electron supervision (below).
- Electron supervision done: `src/shell/policy.ts` (`crashDecision`, `isHiddenStart`), `electron/main.cjs` (page crash/hang/load-fail recovery, flush before quit/suspend/lock/session-end via `wp:flush`/`wp:flushed`, `--hidden` start, login item set once with `--hidden`), preload + `desktopBridge.ts` (`onFlush`, `flushed`), App flush handler + `registerFlush`. Verified: starts hidden on a test profile and serves /api/health; unit 898, smoke 48/48. NOT tested: a real renderer crash, the quit flush, packaged installer.
- Stage 2 still open: utility-process server with restart, crash-loop safe mode, hung-instance takeover, sync outbox (`syncedAt` = request start), widget 'Not updating' marker. Older text: Electron supervision (utility process, watchdogs, hidden start, flush), sync outbox. Then stages 3 to 6.
- Update `CLAUDE.md` (storage engine, disk copies, `~/WorkPulse`); `desktop:pack` not tried; ask the user whether to commit.
- Before smoke/restore checks: make sure no old dev server holds port 3000 (a stale one gave false results).

## Files changed
- `src/server/localCopy.ts`, `server.ts` — disk copies and routes.
- `src/utils/persist/{diskMirror,reconcile,copyFormat,keys}.ts`, `src/hooks/useDiskCopy.ts`, `src/components/DiskCopyBanner.tsx`, `src/App.tsx` — mirror, restore offer.
- Earlier stages: `src/utils/storage.ts`, `src/utils/persist/engine.ts`, `src/utils/net/`, `src/utils/health/`, `src/shell/`, `electron/`, `scripts/`, `tests/smoke/`.

## Please test
- Run the app, add a log, wait 20 s, check `~/WorkPulse/backups/localhost-3000/latest.json`; open it in a fresh browser profile and use "Restore my data".
- Lint: passes. Unit 881, smoke 48/48.
