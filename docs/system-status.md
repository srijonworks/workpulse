# System status

Settings -> **System status** says, in plain words, whether WorkPulse is saving, copying and syncing. Each row is **OK**, **Needs a look**
or **Problem**, with one sentence, the last time it worked, and sometimes a button. A failure stays quiet at first, because most heal
by themselves; a row only turns to "Needs a look" once the problem has lasted past that part's limit.

| Row | What it means | What to do |
|---|---|---|
| **Saving** | Every change you make is written to this browser's storage. Problem: changes are not saved yet, the browser is full, or part of your data could not be read (WorkPulse then refuses to change it). Needs a look: this window is read-only because WorkPulse is open in another window, or storage is over 80 % full. | **Try again** retries the save. **Download a backup** when the browser is full or data cannot be read, then free space (remove old screenshots) or restore from the disk copy. For a read-only window close the other one, or choose "Use this window". |
| **Disk copy** | A second copy of your data is kept on this computer (`~/WorkPulse/backups`), a few seconds after a change. Needs a look: it has not worked for 30 minutes, it belongs to another browser profile, or the copy on disk is newer than this page. Problem: WorkPulse cannot reach its own server. | Check that the app or `npm run dev` is still running and press **Try again**. On "another browser profile" choose which data to keep when asked. If the copy is newer, restart WorkPulse and read the restore offer. |
| **Google Sheet sync** | Logs and the backup in your Sheet. Shows "Not set up" when there is no Sheet link. Needs a look after 2 hours of failures (3 in a row), Problem after 24 hours. | Open Settings -> Google Sheet and test the connection. If it says to redeploy the script, follow the steps in `docs/phone-and-email-setup.md`. |
| **Phone and evening email** | Tasks from the phone page and the daily summary email. Optional. Needs a look after an hour of failures. | Open Settings -> Phone & evening email; check the PIN and send a test email. |
| **Activity readers** | The git, Claude Code, OpenCode, Codex and document readers behind suggestions. "No check yet" is normal before the first scan. | Accept the data notice, check the folder links in Projects & tags, and make sure `git` and `claude` work in a terminal. |
| **Automatic day** | The start-of-day popup, the clock-out safety net and the day-close job that adds automatic logs. "Switched off" means `autoDayEnabled` is false. A day that failed to close is retried (1, 5, 15, then 60 minutes). | Keep WorkPulse open after clocking out. Closed days appear below as "last 7 days"; an automatic log can be undone from its toast or deleted by hand. |
| **Screens** | A part of the app crashed in this session. The rest keeps working, and your data is saved first. | Press **Try again** or reload the page. If it repeats, copy the diagnostics and the log file. |
| **Desktop app** | Whether you are in the desktop app (crash recovery, saving before quit). In a browser it says so. | Nothing, unless it reports a problem: see `docs/desktop-app.md`. |

Below the rows:
- **Storage** shows how much of the browser's storage is used.
- **Automatic day, last 7 days** lists each day as closed with logs, closed with nothing to add, or not closed.
- **Repairs** lists what the data doctor fixed at load (a repeated id, an impossible duration, a clock-out before its clock-in). It never
  deletes anything and the list never shows what you wrote.
- **Copy diagnostics** copies counts and states only: no log text, names, folder paths, Sheet addresses or keys. Safe to paste into a report.

The log file is `~/WorkPulse/logs/` (rotating, 1 MB, three files). It records what happened and where, never what you wrote.
