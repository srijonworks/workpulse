# WorkPulse

A single-user office record. Log your work, run task timers, clock in and out, and close the day with an AI-written
standup and an end-of-day timesheet. Logs can be drafted for you from the day's git commits and Claude Code prompts.

Your data stays on your computer (browser localStorage). AI and Google Sheets sync are optional.

## What it does

| Area | What you get |
|---|---|
| **Today** | Quick-add tasks (Enter = planned, Shift+Enter = start now, `#project` picks the project), a quick work log, suggested logs from your activity, Standup, Sync and **End my day**. |
| **Tasks** | Tasks grouped by date (Earlier, Today, Upcoming, Done recently), start/pause/resume timers, "Log it" to turn tracked time into a log, "Write timesheet" for a group of done tasks. |
| **History** | Every log with search and project filter, a week strip of minutes per project per day, and export as Markdown or CSV. |
| **Office clock** | Clock in and out against a target workday (default 8 h). The header shows time left and always offers the one sensible next action. |
| **Suggested logs** | Reads the day's git commits and Claude Code prompts from folders linked to your projects, and an AI groups them into one log per project. You tick, edit and add. |
| **End my day** | Review suggested logs, check today's log, sync, then clock out (running timers are paused). |
| **Phone page** (optional) | A PIN-protected page on your Google Sheet to add tasks from your phone, and a daily summary email. |
| **Desktop app** (optional) | Windows installer (Electron) with a tray icon, self-update and two small desktop widgets (time left, running tasks). |
| **Themes** | Three: *The Chase* (default), *Time Card*, *Graphite Console*. |

Durations always come from tracked timers. The only estimate is for activity suggestions, which is labelled
"estimated" and editable before you add it.

## How it works

```
Browser (React 19 SPA)                         Express server (server.ts, no database)
┌──────────────────────────────┐   fetch       ┌────────────────────────────────────────┐
│ App.tsx owns all state       │ ────────────▶ │ /api/gemini/generate    standup text   │
│  logs, tasks, workdays,      │               │ /api/synthesize-eod     timesheet      │
│  projects, tags, settings    │               │ /api/activity/*         git + Claude   │
│                              │               │                         history reader│
│ localStorage  ◀── read/write │               │ /api/sheets/proxy  ──▶ Google Apps     │
└──────────────────────────────┘               │                        Script (Sheet) │
                                               │ /api/pick-folder        Windows dialog │
                                               └──────────┬─────────────────────────────┘
                                                          │ runs locally
                                                          ▼
                                       `claude -p` (your login) or Gemini API
```

- **State and storage.** `src/App.tsx` holds all state and every handler. Screens and dialogs only receive props.
  Data is saved to localStorage keys `workpulse_logs`, `workpulse_backlog`, `workpulse_projects`, `workpulse_tags`,
  `workpulse_settings` and `workpulse_workdays`. A 1-second interval adds elapsed time to running tasks.
- **Server.** A thin proxy. It holds no data. In development it mounts Vite as middleware, so UI and API share
  `http://localhost:3737`.
- **AI writer.** One setting (Settings → AI) for standup, end of day and suggestions: **Claude Code** (default; runs your own
  `claude -p`, no API key), **Gemini** (needs a key), or **none** (plain templates, no AI call). If the AI fails, the app
  falls back to templates and says why.
- **Activity suggestions.** The server reads the day's git commits and Claude Code session history from folders you link to
  projects. Text is redacted of secrets before it goes to an AI. These routes answer only on `127.0.0.1` with a strict
  `Host` check, because they read local files.
- **Google Sheet sync and backup.** You paste a generated Apps Script into your own Sheet and deploy it. The app then syncs
  logs, keeps a versioned full backup in the Sheet and serves the phone page and evening email. After any script change you
  re-paste it and update the existing deployment.
- **Dates are local.** Everything uses your local date, so work at 02:00 counts for that day. Tasks never roll over on their
  own: they keep their date until you move them.

## Quick start

**Needs:** Node.js 20.19+ or 22.12+.

### Windows: one click

Double-click **`run.bat`**. It checks Node, installs dependencies, creates `.env.local`, picks a free port and opens
http://localhost:3737.

- `run.bat prod` runs an optimized production build
- `set PORT=4000` first to choose another port, `set NO_BROWSER=1` to skip opening the browser

### Manual (any OS)

```bash
npm install
npm run dev        # http://localhost:3737
```

For production: `npm run build`, then `NODE_ENV=production npm start`.

### Optional setup

- **AI:** nothing to do for Claude Code if `claude` is installed and signed in. For Gemini, put `GEMINI_API_KEY` in
  `.env.local` or paste a key in Settings.
- **Google Sheet, phone page, evening email:** see [docs/phone-and-email-setup.md](docs/phone-and-email-setup.md).
- **Desktop app and widgets:** see [docs/desktop-app.md](docs/desktop-app.md).
- **Activity suggestions:** see [docs/suggested-from-activity.md](docs/suggested-from-activity.md).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server with live reload |
| `npm run build` | Production build into `dist/` |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` | Type-check only (`tsc --noEmit`) |
| `npm run test:smoke` | Browser smoke test (Python Playwright; stubs AI and Sheet calls) |
| `npm run desktop:build` | Build the Windows installer |

## Project layout

```
server.ts                 Express server and API routes
src/
  App.tsx                 All state and handlers
  types.ts                Data types
  components/v2/          Shell, Today, Tasks, History, Settings, dialogs
  components/widgets/     Desktop widgets
  components/ui/          Shared primitives (ModalShell, IconButton)
  utils/                  Pure, unit-tested helpers (dates, storage, backup, activity, phone, sheet)
  utils/appsScript/       The Google Apps Script, composed as strings
  server/                 Activity readers, Claude CLI runner, folder picker
  hooks/                  Phone sync, Sheet backup, widget bridge
electron/                 Desktop shell
tests/smoke/              Browser smoke tests
docs/                     Setup guides
```

## Tech

React 19, TypeScript, Vite, Tailwind CSS v4, Express, `lucide-react`, Electron (desktop), Vitest and Playwright (tests).

## Privacy

- All work data lives in your browser's localStorage. Nothing is sent anywhere unless you turn on AI or Sheet sync.
- With the Claude Code writer, requests go through your own `claude` login. Your Gemini key is sent to the server only when
  Gemini is chosen and is never included in backups.
- The server binds to `127.0.0.1` by default. Setting `HOST=0.0.0.0` opens it to your network, which has no
  authentication.

## Origin

First generated with Google AI Studio, then redesigned and extended by hand.

See [CLAUDE.md](CLAUDE.md) for the detailed architecture notes.
