---
name: data-model-change
description: Use whenever a field is added, removed, renamed, or retyped in src/types.ts (WorkLog, BacklogTask, Project, AppSettings, or related types). Walks every place the field must be handled so existing users' localStorage data keeps loading, seed data and Google Sheets sync stay consistent, and the v2 screens display it.
---

# Data model change checklist (WorkPulse)

All user data lives in browser localStorage. Users already have saved data **without** your new field,
so every change must load old data safely. Work through each step; skip only the ones that clearly
don't apply, and say which ones you skipped and why.

## 1. Types — `src/types.ts`
- Update the interface (`WorkLog`, `BacklogTask`, `Project`, `AppSettings`, or the unions `TaskStatus`, `TaskStage`, `ThemeId`, …).
- Prefer an **optional** field (`foo?: T`) for new data; old records won't have it.
- For a rename or retype, note the old shape: you will need it for the migration in step 2.

## 2. Migration — `src/utils/storage.ts` → `loadStoredData()`
- Keys: `workpulse_logs`, `workpulse_backlog`, `workpulse_projects`, `workpulse_tags`, `workpulse_settings`, `workpulse_workdays` (`KEYS` object in `src/utils/storage.ts`; the old `workpulse_active_draft` key is no longer used).
- **Workdays** are validated by `isWorkdays` (`src/utils/workday.ts`); a new `WorkdayRecord` field must pass it. Settings' `theme` goes through `normalizeTheme` (`src/utils/theme.ts`).
- **Backlog** already has a normalisation pass (`backlog.map(...)` that fills `stage`, `elapsedSeconds`, `isRunning`, and reopens segments for running tasks). It does not roll `dueDate` forward: pending tasks keep their date. Add defaults / rename handling there.
- **Logs and projects** are parsed with a bare `JSON.parse` cast and **no** normalisation. If old records need a default, rename or type conversion, add a `.map()` after parsing.
- **Settings** are merged as `{ ...DEFAULT_SETTINGS, ...stored }`, so a new `AppSettings` field gets its default automatically once it's in `DEFAULT_SETTINGS` (step 3). Renames still need explicit handling. The optional fields added for the phone page and email (`BacklogTask.fromPhone`; `AppSettings.phoneToken`, `phoneSyncAt`, `phoneDeviceId`, `phoneLastError`, `activityAutoScan` (optional; absent = on), `emailEnabled`, `emailTime`) have no default: absent means off / 18:00, and `storage.test.ts` checks they survive a load.
- If you migrate, write the result back (as the backlog branch does with `localStorage.setItem`) so it only runs once.
- Never throw: the `catch` falls back to seed data, which would look like data loss to the user.

## 3. Seed and default data — `src/data/seedData.ts`
- `INITIAL_PROJECTS`, `INITIAL_TAGS`, `DEFAULT_SETTINGS`, and `getInitialSeedData()` (sample logs and backlog tasks with dates relative to today).
- Add realistic values to the sample records if the field should show up in the demo.
- `src/App.tsx` starts from `useState<AppSettings>(DEFAULT_SETTINGS)`, so nothing is duplicated there.
- Backups: `src/utils/backup.ts` (`buildBackup`, `parseBackup`) if the data belongs in the backup file (device-only settings do not). Device-only today: `geminiApiKey`, `lastBackupAt` and the phone fields `phoneToken`, `phoneDeviceId`, `phoneSyncAt`, `phoneLastError`, `sheetBackupAt`, `sheetBackupError`; `buildBackup` omits them, `parseBackup` clears them, and `keepDeviceSettings` (`src/utils/phoneSettings.ts`, used by `handleImportBackup`) keeps this computer's own over an import. A new device-only field goes in all three places.

## 4. Places that create records — `src/App.tsx` and components
New `WorkLog` objects are built in several places. Set the field (or leave it undefined on purpose) in each:
- `App.tsx`: `handleAddLog`, `handleAddLogs` (activity suggestions), `handleUpdateLog`, `handleDuplicateLog`, `handleConvertTaskToLog`, `handleConfirmEodPush`
- `components/v2/LogFormDialog.tsx` (the add/edit form; it copies fields it does not edit from `editing`)
- `components/v2/today/TodayLog.tsx` (the one-line quick log on Today)
- `components/activity/ActivitySuggestionsDialog.tsx` (`ActivitySuggestionsPanel` builds the logs it adds) and `src/utils/activity/suggestions.ts`
- `components/EodSynthesizerModal.tsx` (`SynthesizedLogItem`, mapped into `WorkLog` in `handleConfirmEodPush`)

`BacklogTask` objects: `handleAddBacklogTask`, `handleUpdateTaskStage`, `handleReopenTask`, `handleCompleteTask`, `handlePauseTask` in `App.tsx` (timer `segments` go through `src/utils/segments.ts`). Workdays: `handleClockIn`, `handleClockOut`, `handleResume`.

## 5. Google Sheets sync (only `WorkLog`s sync)
- `src/utils/sheetsSync.ts` (`syncSingleLogToSheet`, `syncBatchLogsToSheet`) spreads the whole log, so a new field is **sent** automatically. Only `imageBase64` is rewritten. Exclude or transform large or sensitive fields here.
- `src/utils/googleAppsScriptTemplate.ts` (`GOOGLE_APPS_SCRIPT_CODE`) writes **fixed columns**. To store the field, update all three in the same column order:
  1. `appendRow([...])` in the `appendLog` branch of `doPost`
  2. `rows.push([...])` in the `batchSync` branch
  3. the `headers` array in `getOrCreateLogsSheet()`
  Keep the `Id` column **last** (12th): the script upserts rows by it (`upsertRows`, `ID_COL`), so new columns go before it only if `ID_COL` moves too. `WorkLog.syncedAt` is set by the app after a confirmed sync, and manual Sync sends only logs that need it (`src/utils/syncStatus.ts`).
- The script is composed from `googleAppsScriptTemplate.ts` (header and the v2 log code), `src/utils/appsScript/core.ts` (PIN, token, state and inbox tabs, phone data), `email.ts` (evening email) and `phonePage.ts` (phone page). A field that the phone page, the snapshot or the email reads goes through `src/utils/phoneSync.ts` (`buildSnapshot`, `mergeInbox`) and the matching script code, and is tested with the Node harness `src/test/appsScriptHarness.ts` (`npx vitest run src/utils/appsScript`). Script helpers end in `_`; any top-level name without `_` is callable from the public phone page, and `core.test.ts` pins that list. Sheet dates are normalised with `Utilities.formatDate` and date columns written as text.
- Tell the user: an already-deployed Apps Script must be **re-pasted and redeployed** (edit the existing deployment, New version, so the URL stays; see `docs/phone-and-email-setup.md`). An existing `WorkPulse_Logs` sheet keeps its old header row, because headers are only written when the sheet is first created, so the header needs adding manually.

## 6. Display (one layout; check it in all three themes)
- `components/v2/today/LogRow.tsx` (every log list: Today, History, End my day) and `TaskRow.tsx` (`metaFor`; Today and Tasks).
- `components/v2/LogFormDialog.tsx` if the field should be editable.
- `components/v2/tasks/TasksScreen.tsx` and `src/utils/taskSections.ts` for `BacklogTask` fields that change grouping.
- `components/v2/history/HistoryScreen.tsx`, `WeekStrip.tsx` (`src/utils/weekTotals.ts`) and the exports in `src/utils/exportLogs.ts` (CSV, Markdown).
- `components/v2/ClockBand.tsx` and `src/utils/workday.ts` for workday fields; `components/v2/endday/EndDayDialog.tsx` for anything End my day shows.
- `components/SearchPaletteModal.tsx`: add the field to the search filter if it's text worth searching.
- `components/SettingsView.tsx` (and `components/v2/settings/ProjectsSection.tsx` for project fields).

## 7. AI reports (if the field should influence them)
- `src/utils/aiGenerator.ts`: `generateAiReport` (the `logsSummary` line builder) and `generateFallbackTemplate` (offline templates).
- `server.ts`, `app.post('/api/synthesize-eod')`: `promptPayload` (task fields sent to Gemini), the JSON schema inside `systemInstruction`, `generateFallback()`, and the `finalResults` mapping.

## 8. Verify
- `npm run lint` must pass (tsc --noEmit).
- In the browser at http://localhost:3737 (`npm run dev`), **keep your existing localStorage data**: confirm old records still load and render in all three themes (Settings → Appearance), and that new records save the field.
- Run `npm run test:smoke` (port 3737 free) and add a check to `tests/smoke/smoke.py` if the field adds a flow.
- If sync changed, test it against a scratch Google Sheet.
