# Phone page and evening email: setup and first-deployment checklist

WorkPulse can show today's tasks and logs on your phone, take tasks you type on the phone, and email you a
summary of the day. All of it runs inside your own Google Sheet's script (Google Apps Script). Nothing new
runs on a server of ours, and WorkPulse itself stays on one computer.

You need the Google Sheet you already sync logs to, with its script. A phone and an email address
(your Google address) are all else.

## One-time setup

1. Open WorkPulse, then **Settings > Google Sheet**. Open **Set up the sheet: Apps Script code** and press **Copy code**.
2. Open the Sheet. Choose **Extensions > Apps Script**. Delete the old code, paste the new script and save.
3. Update the deployment you already have, so the link stays the same:
   **Deploy > Manage deployments**, press the pencil on your existing deployment, set **Version** to
   **New version**, press **Deploy**. Do not choose **New deployment**: it makes a new address and WorkPulse
   would stop reaching the Sheet. (First time ever? Follow the steps at the top of the script instead.)
4. Google asks for permission again. Allow all of it: the Sheet, sending email to you, and running timers (the daily one and
   the one-off ones that send a standup email later).
   (If a screen says the app is not verified, choose Advanced and continue; it is your own script.)
5. Back in WorkPulse, **Settings > Phone & evening email**. The section should say the script is version 12.
   If it says an older version, the paste or the new version in step 3 did not take; repeat them.
6. Press **Set PIN** and type a 4-digit PIN twice. WorkPulse keeps only a token for this computer, never the PIN.
7. Choose the time for the evening email (from 00:30 to 23:29), tick **Send me an evening email**, press **Save**, then
   **Send a test email**.
8. Open the **phone link** shown there on your phone (it is your Sheet's `/exec` address with `?page=phone`),
   type the PIN once, then add the page to the home screen (Share > Add to Home Screen on iPhone; the menu >
   Add to Home screen on Android). Keep the link private: anyone with the link and the PIN can read your tasks.

Notes:

- **Set the PIN straight after deploying.** If no PIN was ever set, anyone who has the link can set the first one.
- Use this on **one computer only**. If a second computer also sends data, the section warns about it.
- Five wrong PINs in a row lock the phone page for 15 minutes (each further wrong PIN locks it again).
  **Change PIN** in Settings, which this computer can do without the old PIN, sets a new PIN and clears the lock.
  **Reset phone access** is for a computer that has lost its access: it asks for the current PIN and a new one.
- Updating WorkPulse's script in future (a new version of the app may bring a new script): paste it again and update
  the same deployment (step 3). The change only takes effect after that new version is deployed.
- The Sheet gains tabs (`WorkPulse_Tasks`, `WorkPulse_Days`, `WorkPulse_Recent`, `WorkPulse_Inbox`,
  `WorkPulse_Projects`, from version 4 `WorkPulse_Backup`, and from version 6 `WorkPulse_DayHistory` and `WorkPulse_Standups`).
  `WorkPulse_Logs` keeps its columns and gains an `Origin` column at the end (version 6; `auto` for a log WorkPulse wrote itself).
  Do not edit the new tabs; WorkPulse rewrites them.

## Updating to script version 12

Version 12 changes the top of the day emails for a day run on logs alone (most of them automatic). When the day has
no done and no open tasks, the tiles read **logged**, **things done** (each log's sub-tasks, or 1 for a log without
any) and **projects**, instead of "0 tasks done" and "0 still open", and the text email leaves out the empty
"Still open" part. A day with tasks shows the task tiles as before. Update the script with the same steps as for
version 8 below. It also includes version 11.

## Updating to script version 11

Version 11 takes Google's newer Gemini keys (they start with `AQ.` and contain dots). Version 10 and older refused
**Save email settings** with "That Gemini key does not look right." whenever such a key was set in Settings > AI, so the
Sheet's 15-minute email timer was never set up and the clock-out email waited for the PC. From version 11 a key that
still does not fit is only left unsaved; the email settings and the timer always save. Update the script as below, then
press **Save email settings** once. Until you update, WorkPulse does not send a dotted key to the older script, so the
save (and the timer) works there too, and the Sheet writes its standups in plain wording.

## Updating to script version 10

Version 10 adds **Clock out** to the phone page. Update the script with the same steps as for version 8 below (paste,
then a **New version** of the existing deployment); Settings shows a notice until the Sheet runs version 10.

- The phone page shows a **Clock out** button in the green band while the day is open in the Sheet: today, or yesterday
  when today has no clock-in yet (working past midnight). It asks for the time you left (now by default; a past time
  must be after the clock-in) and shows the worked time before you confirm.
- The Sheet closes the day **at once**, so the day's email still goes when the PC is off. It keeps the clock-out until
  WorkPulse on the PC takes it (within a minute while WorkPulse runs, or at its next start). The PC then closes the same
  day at that time and pauses any running timer there, with a message and **Resume** as usual.
- **The first clock-out wins.** If the PC already clocked out (by hand, End my day or the automatic clock-out), the PC's
  time stays and the phone's is dropped.
- **Undo** on the phone works for 10 minutes and only until the PC has taken the clock-out. After that, use **Resume**
  on the PC.
- The "when I clock out" email waits for the PC, so the PC can send its logs and standup first: until the PC takes the
  clock-out, at most 60 minutes, then the Sheet sends with its own standup. Once the PC has it, the usual 10 minutes.
- **Settings > Phone & evening email > Allow clock out from the phone** (on unless switched off). When off, the phone
  page hides the button and the Sheet refuses the request. Only the PC can switch it, so a PIN on its own cannot.

## Updating to script version 9

Version 9 changes only how the emails look (the designs in `docs/email-designs/`): a bigger hours figure, In and Out as
separate figures, project labels in capitals, coloured pills for paused and blocked tasks, and sizes that fit a phone.
Nothing about when or how emails are sent changes. Update it with the same steps as for version 8 below; Settings shows a
notice until the Sheet runs version 9.

## Updating to script version 8

Version 8 makes the email sent **when you clock out** come from the Sheet itself, so it still arrives when you shut the PC
down right after clocking out.

- **How it works:** a timer in the Sheet runs every 15 minutes. WorkPulse sends your clock-out and the day's logs to the
  Sheet about 5 seconds after you clock out. Once the clock-out has reached the Sheet, the timer sends the day's email:
  - at once, if your PC's standup has arrived;
  - otherwise 10 minutes after the clock-out, with a standup the Sheet writes itself.
  So the email arrives 10 to 25 minutes after you clock out.
- **Forgotten clock-out:** a day you never clocked out of is sent just after midnight.
- **Thursdays:** the week standup (Friday to Thursday) is sent the same way.
- **Gemini:** the Sheet writes the standup with your Gemini key (from **Settings > AI**, sent when you press
  **Save email settings**). It keeps the key in the script's own settings and never sends it back.
- **When Gemini fails:** a rate limit, a server error, a refused key or a missing permission only means the standup is
  written in plain wording from your logs. The email is never held back.
- **No doubles:** each day and week is sent at most once, whether the PC or the Sheet sends it first.
- **Only from today:** days before you switched this on are never sent.

1. Copy the new script, paste it and update the **existing** deployment (steps 1 to 3 below).
2. Allow the new permission Google asks for (**connect to an external service**, used for Gemini). If your
   `appsScript.json` lists scopes, add the line shown in **Google says a permission is missing?** in Settings.
3. In WorkPulse, **Settings > Phone & evening email**: check it says version 8, choose **When I clock out**, and press
   **Save email settings**. This step creates the Sheet's timer; until you press it, nothing changes.
4. To change the Gemini key later, change it in **Settings > AI**, then press **Save email settings** again.

## Updating to script version 7

Version 7 changes only the email sent **when you clock out**: it is now the same designed email as the fixed-time one
(worked time, clock-in and out, logs per project, done and open tasks) for that day, with the day's standup as the first
section, its bold marks drawn as bold and its points grouped under each project. Before, it was the bare standup text.
Update it with the same steps as below; nothing else changes.

## Updating to script version 6

Version 6 adds: log writes that wait for the Sheet's lock (a busy Sheet answers "busy" and nothing is written, so WorkPulse
simply sends the log again later), the `Origin` column, the `WorkPulse_DayHistory` and `WorkPulse_Standups` tabs, standup
emails from your own Gmail (a day's or a week's standup text plus a link to the Sheet, sent at most once each, optionally
a little later), and a form on the phone page to add a log for work done outside the office. Version 5 of WorkPulse keeps
working with a version 6 script; the new features wait until the script says version 6.

1. In WorkPulse, **Settings > Google Sheet > Set up the sheet: Apps Script code**, press **Copy code**.
2. In the Sheet, **Extensions > Apps Script**, delete the old code, paste the new script, and save.
3. **Deploy > Manage deployments**, press the pencil on your existing deployment, set **Version** to **New version**,
   press **Deploy**. Never choose **New deployment**: it makes a new address and WorkPulse would stop reaching the Sheet.
4. Allow the permissions Google asks for (sending email and timers are used by the standup emails).
5. In WorkPulse, **Settings > Phone & evening email** should now say version 6 (or open the `/exec` link with `?action=ping`).

## Backup to the Sheet

From script **version 4**, WorkPulse keeps a full copy of your data in the Sheet, in the `WorkPulse_Backup` tab, so a
cleared browser or a dead computer does not lose it.

- **What is saved:** logs, tasks, projects, tags, clock-ins and settings (the same content as **Download JSON backup**).
  **Not saved:** the screenshots attached to old logs (too big for a Sheet), your Gemini key and the phone link.
- **When:** about 30 seconds after a change, at least every 10 minutes while a timer runs, and once when you open
  WorkPulse if the last copy is over an hour old. A fresh profile that only holds the demo data is never copied by itself.
  The last 3 copies are kept. A copy over 20 MB is refused with a message.
- **Where to look:** **Settings > Phone & evening email > Sheet backup** shows the last copy and its counts, a
  **Back up to the Sheet now** button, and the saved copies.
- **Restore:** press **Restore this copy** on a copy, then confirm. WorkPulse first downloads your current data as a
  file (`workpulse-before-restore-<date>.json`), then replaces everything on this computer with the copy and reloads.
  Screenshots stay on logs that are still on this computer.
- **On a new browser:** paste your Sheet link in **Settings > Google Sheet** and save, then **Reset phone access**
  (it asks for your PIN and a new one) so this browser gets a token, then restore. The PIN is not stored.
- **Redeploy needed:** with script version 3 the phone page and email still work, but the backup needs version 4.
  Paste the new script and update the existing deployment (step 3 above, **New version**).

## Manual checklist for the first real deployment

The automated tests use fakes for Google. Do these once against the real Sheet, and tick them off.

1. **Version.** WorkPulse Settings > Phone & evening email says script version 12 (or open the `/exec` link with
   `?action=ping`; it answers `"version":11`).
2. **Same URL.** After step 3 above the link in WorkPulse still works with no change. (Editing the existing
   deployment keeps the URL; **New deployment** would not.)
3. **Phone page opens.** `<your /exec link>?page=phone` shows the PIN keypad. A wrong PIN says so and counts the
   tries left; the right PIN opens the tasks.
4. **Phone to desktop.** Add a task on the phone (Add tab). Within about a minute it appears in WorkPulse with
   "from phone", and only once, even after you reload WorkPulse.
5. **Desktop to phone.** After WorkPulse has sent its data (a few seconds after a change, the status line in
   Settings shows the time), the phone shows today's tasks and today's logs.
6. **Test email.** **Send a test email** arrives from your own Google address, at your own address.
7. **Trigger.** In the Apps Script editor, **Triggers** (the clock icon) lists one daily time-based trigger for
   `sendEveningEmail`. It fires within about 15 minutes of the chosen time, and the email arrives once per day.
8. **Quiet day.** On a day with no logs and no clock-in nothing is sent.
9. **A task titled `=1+1`.** Add a phone task with exactly that title. In the Sheet (`WorkPulse_Inbox` and then
   `WorkPulse_Tasks`) and in WorkPulse it stays the text `=1+1`; it is never calculated.
10. **Times round-trip.** The Time cells of `WorkPulse_Logs` in the Asia/Dhaka zone show up with the right time in
    the phone page's logs under **Show earlier days** (Sheets can store them as dates).
11. **Time zone check.** In the script editor, run `Utilities.formatDate(new Date(), 'Not/AZone', 'yyyy-MM-dd')`
    in a scratch function: it should throw. The script relies on that to reject a bad time zone.
12. **Standup email.** With a standup saved for a day, send it with no delay: one email arrives from your own address with
    the text and a link to the Sheet; asking again sends nothing more. Send one with a 2-minute delay: the Apps Script
    **Triggers** list shows a one-off trigger for `sendEveningEmail`, the email arrives once, and the trigger is gone afterwards.
13. **Log from the phone.** On the phone page, Add tab, **Log work done outside the office**: the log shows under Log
    right away and as a row in `WorkPulse_Logs`.
14. **Clock out from the phone.** With the day open, press **Clock out** on the phone and confirm. `WorkPulse_Days`
    shows the clock-out at once; within about a minute WorkPulse on the PC shows "Clocked out from your phone at …" and
    the band shows the day closed. Try **Undo** once within 10 minutes before the PC is running: the day opens again.
15. **Google's script runner on the phone.** `google.script.run` works from the phone page that opens without a
    Google sign-in, and the remembered PIN survives a page reload on iPhone Safari and on Android Chrome. This is
    best effort: if a browser forgets the PIN, typing it each time is acceptable.

## Offline tests

These need no Google account and no dev server (except the smoke test, which starts its own).

- `npm test`: unit tests, including the Apps Script run in a Node harness with fake Sheet, lock, mail and trigger
  services (`src/test/appsScriptHarness.ts`).
- `npm run lint` and `npm run build`.
- `npm run test:smoke`: browser smoke test of the desktop app. The Sheet is stubbed; the run fails if a request
  would reach a real `script.google.com` host.
- `python tests/smoke/phone_page.py <screenshot dir>`: opens the phone page in Chromium at 390 px, with
  `google.script.run` replaced by a stub, and saves screenshots to the folder you name. On Windows set
  `PYTHONIOENCODING=utf-8` first so the console prints the middle dot.
