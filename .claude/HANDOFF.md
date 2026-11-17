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
- Stage 3A readers (server side) done: `src/server/readCodex.ts`, `readOpenCode.ts` (node:sqlite read-only, v1+v2 tables), wired into `scanActivity` (read only when `sources.codex` / `sources.opencode` is true); types widened (`ActivitySource`, optional `ActivitySources.opencode/codex`); `describeSources`/`noticeSignature` handle them (signature unchanged while they are off). Tested on synthetic fixtures and on the real histories here (counts only).
- Stage 3A client done: Settings checkboxes + `activityUseOpenCode/Codex` (default on), notice signature `git+claude+opencode+codex|claude` (users re-consent once), scan route passes both, evidence/prompts handle them. `app_loads` smoke flaked once (passes on rerun; cause unknown).
- Stage 3A readers finished: `src/server/readDocuments.ts` (names + times, bounded walk, source `docs`, Settings toggle `activityUseDocs`) and `src/server/gitChanges.ts` (uncommitted changes as `wip:` items under source git). Notice signature now `git+claude+opencode+codex+docs|claude`. Documents are read only inside project-linked folders (no Documents-folder watch yet).
- Auto-projects done: `utils/activity/autoProjects.ts` (watch folder = setting or common parent of linked folders; real work = commit/uncommitted/doc or 2+ prompts), `hooks/useAutoProjects.ts` (20 s after load, every 10 min, only after the data notice was accepted), `POST /api/activity/discover`, shared `utils/activity/folderMatch.ts`, settings `activityAutoProjects/WatchFolder/IgnoredFolders` (delete-forever adds the folder to ignored). NO Settings UI yet for the toggle, watch folder or ignored list; no merge-projects feature. Verified discover on real E:\Projects (11 repos); the creation flow itself was not run end to end.
- Stage 3B done (clock automation): pure `src/utils/autoDay/` (`startPrompt`, `autoClockOut`, `busy`), `hooks/useAutoDay.ts` (60 s tick; page input = activity; Fri/Sat scan probe), ClockInDialog `suggestedAt` + auto-confirm after 10 min only if the PC was used, `handleAutoClockOut`, setting `autoDayEnabled` (absent = on; smoke seeds it off; checks `auto_day_start_popup`, `auto_day_closes_forgotten_day` switch it on with a fixed clock). Smoke 50/50, unit 925.
- 3B limits: idle comes from page input only (no Electron idle IPC yet, so same-day auto clock-out only fires when the window sees no input for 60 min after the target is met); no `clockInHow/clockOutHow` fields, no Undo on auto clock-in; no Settings UI for `autoDayEnabled`; the popup also shows for a forgotten earlier day only after that day is auto-closed.
- Stage 3 next (3C day-close journal): then 3B clock automation (popup, auto clock-out, busy time), 3C day-close journal.
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
