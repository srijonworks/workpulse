// Renders every WorkPulse email from realistic data through the real Apps Script code (the test harness), into one page
// to look at: docs/email-templates.html. Run: npx tsx scripts/render-email-templates.ts
import { writeFileSync } from 'node:fs';
import { createScriptHarness, type ScriptHarness } from '../src/test/appsScriptHarness';

process.env.TZ = 'Asia/Dhaka';
const TZ = 'Asia/Dhaka';
const OUT = 'docs/email-templates.html';

const PROJECTS = [
  { id: 'p-hims', name: 'hims', color: '#d4a72c' },
  { id: 'p-idim', name: 'idim', color: '#3b82f6' },
  { id: 'p-wp', name: 'workpulse', color: '#9b59d0' },
  { id: 'p-gen', name: 'General', color: '#7c8a83' },
];
const pid = (name: string) => PROJECTS.find((p) => p.name === name)!.id;

type Log = { id: string; date: string; time: string; project: string; projectId: string; description: string; status: string; minutes: number; subTasks?: string[] };
const log = (id: string, date: string, time: string, project: string, description: string, minutes: number, subTasks: string[] = [], status = 'completed'): Log =>
  ({ id, date, time, project, projectId: pid(project), description, status, minutes, subTasks });

function setup(now: string): { h: ScriptHarness; token: string } {
  const h = createScriptHarness({ now: new Date(now) });
  return { h, token: h.call('setPin', { pin: '1234' }).token as string };
}

function push(h: ScriptHarness, token: string, today: string, workdays: Record<string, unknown>, logs: Log[], tasks: unknown[]) {
  const r = h.call('pushState', { token, today, tz: TZ, deviceId: 'pc', workdayHours: 8, projects: PROJECTS, workdays, logs, tasks });
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
}

// ---- Thursday 19 November: the clock-out email (with the standup), and the week standup that goes with it ----

const THU = '2026-11-19';
const thuLogs: Log[] = [
  log('t1', THU, '09:09', 'idim', 'Reviewed progress and remaining work on the idim project and checked the provided font files. Updated the gitignore and README documentation.', 19,
    ['Reviewed what was done and what remains', 'Checked the Tahoma and Solaiman Lipi font files', 'Updated the gitignore file', 'Updated the README documentation', 'Drafted a suggestion for the next steps']),
  log('t2', THU, '09:32', 'hims', 'Making HMIS stateless (contd.)', 185),
  log('t3', THU, '09:32', 'idim', "Fixed the known issues of integrated IDIM's Comm Store", 95),
  log('t4', THU, '11:05', 'idim', 'Reviewed and documented the Comm Store progress, then built and ran the application in Docker and checked pagination and reusable table components.', 27,
    ['Updated Comm Store progress notes and README', 'Built the Docker image and ran the application', 'Verified pagination on both server and frontend', 'Listed hand-built tables in forms, details, dashboard and stock pivots']),
  log('t5', THU, '13:40', 'hims', 'Built an async outbox for master data pushes, limited to Dhaka, covering setup pushes and delegator master data.', 94,
    ['Added the outbox table and worker', 'Reviewed the blast radius', 'Documented the remaining gaps']),
  log('t6', THU, '15:20', 'workpulse', 'Reworked the clock-out email into the designed day layout with the standup section, and released version 1.0.18.', 21,
    ['Rebuilt the clock-out email', 'Grouped standup points by project', 'Released version 1.0.18']),
];
const thuTasks = [
  { id: 'k1', title: 'Fix the report template issues of Comm Store', project: 'idim', projectId: pid('idim'), dueDate: THU, stage: 'done', trackedMinutes: 118, completedAt: '2026-11-19T08:00:00.000Z' },
  { id: 'k2', title: 'Implement outbox pattern in hmis master data push', project: 'hims', projectId: pid('hims'), dueDate: THU, stage: 'done', trackedMinutes: 94, completedAt: '2026-11-19T09:00:00.000Z' },
  { id: 'k3', title: "Fix the known issues of integrated IDIM's Comm Store", project: 'idim', projectId: pid('idim'), dueDate: THU, stage: 'done', trackedMinutes: 95, completedAt: '2026-11-19T09:30:00.000Z' },
  { id: 'k4', title: 'Deploy HA readiness and some known fixes to Prod', project: 'hims', projectId: pid('hims'), dueDate: '2026-11-20', stage: 'planned', trackedMinutes: 0 },
  { id: 'k5', title: 'CHUADANGA stock stays stale when a medicine is mapped', project: 'hims', projectId: pid('hims'), dueDate: THU, stage: 'paused', trackedMinutes: 14 },
  { id: 'k6', title: 'Confirm the barcode migration window with the store team', project: 'idim', projectId: pid('idim'), dueDate: '2026-11-17', stage: 'blocked', trackedMinutes: 0 },
];
const weekLogs: Log[] = [
  log('w1', '2026-11-15', '10:00', 'hims', 'Fixed stock issue vouchers so each requisition yields one voucher with atomic stock updates.', 240),
  log('w2', '2026-11-16', '10:30', 'hims', 'Fixed a duplicate-posting gap in the CMSD chalan stock flow.', 190),
  log('w3', '2026-11-17', '09:40', 'idim', 'Investigated a barcode mismatch in the requisition flow and began a safe fix.', 210),
  log('w4', '2026-11-18', '11:00', 'workpulse', 'Added the automatic day: start-of-day popup and the clock-out safety net.', 150),
  log('w5', '2026-11-18', '14:00', 'General', 'Monthly progress meeting with the section head.', 60),
  ...thuLogs,
];
const week = {
  '2026-11-15': { clockIn: '2026-11-15T03:05:00.000Z', clockOut: '2026-11-15T11:20:00.000Z' },
  '2026-11-16': { clockIn: '2026-11-16T02:55:00.000Z', clockOut: '2026-11-16T11:02:00.000Z' },
  '2026-11-17': { clockIn: '2026-11-17T03:10:00.000Z', clockOut: '2026-11-17T10:40:00.000Z' },
  '2026-11-18': { clockIn: '2026-11-18T03:00:00.000Z', clockOut: '2026-11-18T12:15:00.000Z' },
  [THU]: { clockIn: '2026-11-19T02:40:00.000Z', clockOut: '2026-11-19T10:19:00.000Z' },
};
const DAY_STANDUP = `*What I completed today:*
- *hims:* Made HMIS stateless: complaint delivery now runs once per complaint across backend copies.
  - Shared rate limits across copies
  - Reviewed the stateless setup
- *hims:* Built an async outbox for master data pushes, limited to Dhaka.
  - Added the outbox table and worker
  - Documented the remaining gaps
- *idim:* Fixed the known issues of the integrated Comm Store.
  - Verified pagination on both server and frontend
- *workpulse:* Released version 1.0.18 with the designed clock-out email.

*In progress / Rolling over:*
- *hims:* CHUADANGA stock stays stale when a medicine is mapped.

*Blockers / Waiting on:*
- *idim:* Barcode migration window from the store team.`;
const WEEK_STANDUP = `*What I completed today:*
- *hims:* Made HMIS stateless and fixed stock issue vouchers so each requisition yields one voucher.
- *hims:* Closed a duplicate-posting gap in the CMSD chalan stock flow.
- *idim:* Fixed the Comm Store issues and prepared the barcode migration scripts.
- *workpulse:* Shipped the automatic day and the designed clock-out email.

*In progress / Rolling over:*
- *hims:* HA readiness deploy to Prod.

*Blockers / Waiting on:*
- *idim:* Barcode migration window from the store team.`;

const thu = setup('2026-11-13T03:00:00Z');
thu.h.call('setEmail', { token: thu.token, enabled: true, when: 'clockout', tz: TZ });
thu.h.setNow(new Date('2026-11-19T10:21:00Z'));
push(thu.h, thu.token, THU, week, weekLogs, thuTasks);
thu.h.call('saveHistory', {
  token: thu.token,
  standups: [
    { id: `day:${THU}`, kind: 'day', from: THU, to: THU, text: DAY_STANDUP, writer: 'claude', createdAt: '2026-11-19T10:20:00.000Z' },
    { id: `week:${THU}`, kind: 'week', from: '2026-11-13', to: THU, text: WEEK_STANDUP, writer: 'claude', createdAt: '2026-11-19T10:20:00.000Z' },
  ],
});
thu.h.run('sendEveningEmail');
const dayMail = thu.h.mails.find((m) => m.subject.includes('Thu 19 Nov') && !m.subject.includes('week'))!;
const weekMail = thu.h.mails.find((m) => m.subject.includes('week'))!;

// ---- Sunday 22 November, 18:00: the fixed-time evening email while still clocked in ----

const SUN = '2026-11-22';
const sun = setup('2026-11-22T12:00:00Z');
sun.h.call('setEmail', { token: sun.token, enabled: true, when: 'fixed', hour: 18, minute: 0, tz: TZ });
push(sun.h, sun.token, SUN, { [SUN]: { clockIn: '2026-11-22T03:10:00.000Z' } }, [
  log('s1', SUN, '09:42', 'workpulse', 'Moved the daily and weekly email sending to the Google Sheet, so a PC shut down right after clocking out still gets its email.', 21,
    ['Moved daily and weekly email sending to the Google Sheet', 'Made sending resilient to Gemini rate limits and errors', 'Reworked the week standup wording']),
  log('s2', SUN, '10:02', 'workpulse', 'Clocking out now pushes to the Sheet at once, and Windows shutdown waits for the last push.', 18,
    ['Immediate push on clock-out', 'Shutdown hold for one final push', 'Sent / Not sent sign in the clock band']),
  log('s3', SUN, '11:30', 'hims', 'Reviewed the HA readiness checklist before the Prod deploy.', 45),
  log('s4', SUN, '14:10', 'General', 'Team sync on next week priorities.', 30),
], [
  { id: 'n1', title: 'CHUADANGA stock stays stale when a medicine is mapped', project: 'hims', projectId: pid('hims'), dueDate: SUN, stage: 'in_progress', trackedMinutes: 14 },
  { id: 'n2', title: 'Deploy HA readiness and some known fixes to Prod', project: 'hims', projectId: pid('hims'), dueDate: SUN, stage: 'planned', trackedMinutes: 0 },
  { id: 'n3', title: 'Make the email templates easier to read', project: 'workpulse', projectId: pid('workpulse'), dueDate: SUN, stage: 'done', trackedMinutes: 52, completedAt: '2026-11-22T07:00:00.000Z' },
]);
sun.h.run('sendEveningEmail');
const eveningMail = sun.h.mails[0];

// ---- A test email on a day with no data ----

const empty = setup('2026-11-22T02:00:00Z');
empty.h.call('sendTestEmail', { token: empty.token });
const testMail = empty.h.mails[0];

// ---- The page ----

const shown = [
  { title: 'Clock-out email', when: 'Sent by the Sheet 10 to 25 minutes after you clock out (Thu 19 Nov).', mail: dayMail },
  { title: 'Week standup', when: 'Sent with Thursday’s clock-out email (Fri 13 to Thu 19 Nov).', mail: weekMail },
  { title: 'Evening email', when: 'Sent at a fixed time of day; here 18:00 on Sun 22 Nov, still clocked in.', mail: eveningMail },
  { title: 'Test email, no data yet', when: 'Send a test email in Settings before anything is logged.', mail: testMail },
];
for (const s of shown) if (!s.mail) throw new Error(`no mail for ${s.title}`);

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const text = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkPulse emails</title>
<style>
  :root { --bg: #e2e6e2; --ink: #14221b; --muted: #5a6961; --line: #cfd6d1; --green: #0f3d2e; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  header { padding: 28px 24px 8px; max-width: 1400px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 16px; align-items: end; justify-content: space-between; }
  h1 { margin: 0; font-size: 22px; }
  header p { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
  .widths { display: flex; gap: 8px; }
  .widths button { font: inherit; font-size: 14px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); cursor: pointer; }
  .widths button[aria-pressed="true"] { background: var(--green); border-color: var(--green); color: #fff; }
  .widths button:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
  main { max-width: 1400px; margin: 0 auto; padding: 16px 24px 48px; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 640px), 1fr)); gap: 32px; }
  section h2 { margin: 0; font-size: 17px; }
  section p { margin: 4px 0 12px; color: var(--muted); font-size: 13px; }
  .subject { font-size: 13px; background: #fff; border: 1px solid var(--line); border-radius: 8px 8px 0 0; padding: 10px 14px; border-bottom: 0; }
  .subject b { font-weight: 600; }
  iframe { display: block; width: 100%; border: 1px solid var(--line); border-radius: 0 0 8px 8px; background: #eceeea; transition: width .2s; }
  body.phone iframe, body.phone .subject { width: 390px; max-width: 100%; }
  @media (prefers-reduced-motion: reduce) { iframe { transition: none; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>WorkPulse emails</h1>
    <p>Every email the Sheet sends, built from sample data by the real script code. Generated ${new Date().toISOString().slice(0, 10)}.</p>
  </div>
  <div class="widths" role="group" aria-label="Preview width">
    <button type="button" data-w="desktop" aria-pressed="true">Desktop</button>
    <button type="button" data-w="phone" aria-pressed="false">Phone</button>
  </div>
</header>
<main>
${shown
  .map(
    (s) => `  <section>
    <h2>${text(s.title)}</h2>
    <p>${text(s.when)}</p>
    <div class="subject"><b>Subject:</b> ${text(s.mail.subject)}</div>
    <iframe title="${attr(s.title)}" srcdoc="${attr(s.mail.htmlBody)}" loading="lazy"></iframe>
  </section>`,
  )
  .join('\n')}
</main>
<script>
  function fit(f) { try { f.style.height = f.contentDocument.documentElement.scrollHeight + 'px'; } catch (e) {} }
  document.querySelectorAll('iframe').forEach(function (f) { f.addEventListener('load', function () { fit(f); }); });
  document.querySelectorAll('.widths button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.body.classList.toggle('phone', b.dataset.w === 'phone');
      document.querySelectorAll('.widths button').forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      setTimeout(function () { document.querySelectorAll('iframe').forEach(fit); }, 250);
    });
  });
</script>
</body>
</html>
`;
writeFileSync(OUT, page);
console.log(`Wrote ${OUT}: ${shown.map((s) => s.title).join(', ')}`);
