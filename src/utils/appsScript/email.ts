import { GEMINI_MODEL_CASCADE } from '../geminiModels';

// The evening email of the WorkPulse Apps Script: the pure builder, the daily send with its once-a-day
// guard, and the setEmail / sendTestEmail desktop actions. Plain ES5-style Apps Script text, appended
// after SCRIPT_CORE in googleAppsScriptTemplate.ts (it uses the core's helpers: readTab_, getMeta_, ...).
//
// Callable from google.script.run (no "_"): sendEveningEmail (a time trigger needs it public; it sends
// at most once per local date, only to the script owner, and only near the saved time) and buildEveningEmail (pure: it reads nothing
// and sends nothing). Everything else ends with "_".
// All user text is HTML-escaped in the HTML body; the plain-text body has no markup of its own.
//
// Version 6 adds the standup emails (sendDayEmail, emailStatus, cancelDayEmail: token-checked doPost actions, no new
// public function). A one-off time trigger for a delayed standup email runs sendEveningEmail too (a trigger needs a
// public handler), which first sends the standup emails that are due and removes their triggers.
// Version 7: a day's standup email is the designed evening email for that date with the standup as its first section
// (standupHtml_: marks drawn, bullets grouped per project); a week's is the standup alone in the same card.
// Version 8: "when I clock out" is run by the Sheet itself, so a PC shut down at once still gets its email. setEmail with
// when: 'clockout' sets a timer every 15 minutes (handler sendEveningEmail) that sends each closed day (and on a Thursday the
// week) from the Sheet's own tabs: the PC's standup when it is there, else one written with the owner's Gemini key (Script
// Property geminiKey, set by setEmail, never sent back), else plain wording from the logs. A Gemini failure of any kind
// (rate limit, bad key, no permission, slow) only means plain wording: the email always goes.

export const SCRIPT_EMAIL = String.raw`
// =========================================================================
// Evening email
// =========================================================================

var EMAIL_FN = 'sendEveningEmail';
var GEMINI_MODELS = ${JSON.stringify(GEMINI_MODEL_CASCADE)};

// ---- Desktop actions ----

var GEMINI_KEY_PATTERN = /^[A-Za-z0-9_.\-]{10,200}$/;

// { token, enabled, hour, minute, tz, to?, when?, geminiKey? }: when 'fixed' (or absent, as before version 8) one daily
// trigger at the hour; when 'clockout' one trigger every 15 minutes that sends each closed day (sweepStandups_). None when off.
// geminiKey: a text saves it ('' removes it), absent keeps the saved one. It is never sent back.
function setEmailAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  if (c.enabled !== true && c.enabled !== false) return badRequest_();
  if (c.when != null && c.when !== 'clockout' && c.when !== 'fixed') return badRequest_();
  var props = PropertiesService.getScriptProperties();
  var clockout = c.when === 'clockout';
  var hour = c.hour;
  var minute = c.minute;
  var tz = str_(c.tz).slice(0, 100);
  // Who gets the email: empty = the Google account that owns the script. Absent = keep the saved one.
  var hasTo = typeof c.to === 'string';
  var to = hasTo ? recipients_(c.to) : null;
  if (hasTo && to === null) return badRequest_('Enter an email address, or several separated by commas (at most 5).');
  var hasKey = typeof c.geminiKey === 'string';
  var key = hasKey ? c.geminiKey.replace(/^\s+|\s+$/g, '') : '';
  // Google's keys are 'AIza...' or, from 2026, 'AQ.' with dots (version 11). A key that still does not fit is not saved (the
  // saved one stays) and is reported in geminiKeyRejected, but never stops the email settings and their timer from saving.
  var keyRejected = hasKey && key !== '' && !GEMINI_KEY_PATTERN.test(key);
  if (keyRejected) hasKey = false;
  if (c.enabled && clockout) {
    if (!validZone_(tz)) return badRequest_('That time zone is not known.');
  } else if (c.enabled) {
    if (typeof hour !== 'number' || hour % 1 !== 0 || hour < 0 || hour > 23 ||
        typeof minute !== 'number' || minute % 1 !== 0 || minute < 0 || minute > 59) {
      return badRequest_('Pick a time of day between 00:30 and 23:29.');
    }
    // A trigger set close to midnight can fire after midnight, when the day has no data yet.
    if (hour * 60 + minute < 30 || hour * 60 + minute > 23 * 60 + 29) {
      return badRequest_('Pick a time of day between 00:30 and 23:29.');
    }
    if (!validZone_(tz)) return badRequest_('That time zone is not known.');
  }
  try {
    return withLock(function () {
      // The new trigger is created before the old ones go, so a failure leaves the old settings working
      // (and the saved settings still describing them).
      var old = emailTriggers_();
      var saved = {};
      try {
        saved = JSON.parse(props.getProperty('email') || '{}') || {};
      } catch (err) {}
      if (c.enabled && clockout) {
        ScriptApp.newTrigger(EMAIL_FN).timeBased().everyMinutes(SWEEP_EVERY_MINUTES).create();
        // Days before this one are never swept, so switching it on does not mail old days.
        var since = saved.enabled === true && saved.when === 'clockout' && isDateText_(saved.since) ? saved.since : todayIn_(tz);
        saved = { enabled: true, when: 'clockout', hour: saved.hour, minute: saved.minute, tz: tz, to: saved.to, since: since };
      } else if (c.enabled) {
        ScriptApp.newTrigger(EMAIL_FN).timeBased().atHour(hour).nearMinute(minute).everyDays(1).inTimezone(tz).create();
        saved = { enabled: true, when: 'fixed', hour: hour, minute: minute, tz: tz, to: saved.to };
      } else {
        saved.enabled = false;
      }
      if (hasTo) saved.to = to;
      removeTriggers_(old);
      props.setProperty('email', JSON.stringify(saved));
      if (hasKey && key !== '') props.setProperty('geminiKey', key);
      else if (hasKey) props.deleteProperty('geminiKey');
      return {
        status: 'ok', enabled: !!saved.enabled, when: saved.when === 'clockout' ? 'clockout' : 'fixed', hour: saved.hour, minute: saved.minute,
        tz: saved.tz, to: saved.to || '', geminiKey: !!props.getProperty('geminiKey'), geminiKeyRejected: keyRejected
      };
    });
  } catch (error) {
    console.error(error);
    return { status: 'error', code: 'error', message: 'The Sheet script could not set up the daily timer. Paste the latest script, redeploy it as a new version and allow the permissions Google asks for.' };
  }
}

// { token }: today's email now, whatever the day holds. It does not use or change the once-a-day guard.
function sendTestEmailAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  var mail = composeEmail_(true, new Date(), getMeta_());
  var to = sendMail_(mail);
  return { status: 'ok', sent: true, to: to };
}

function emailTriggers_() {
  var all = ScriptApp.getProjectTriggers();
  var oneOff = dayEmailTriggerIds_();
  var mine = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === EMAIL_FN && oneOff[all[i].getUniqueId()] !== true) mine.push(all[i]);
  }
  return mine;
}

function removeTriggers_(list) {
  for (var i = 0; i < list.length; i++) ScriptApp.deleteTrigger(list[i]);
}

function validZone_(tz) {
  if (!tz) return false;
  try {
    Utilities.formatDate(new Date(), tz, 'yyyy');
    return true;
  } catch (err) {
    return false;
  }
}

// Run this once by hand in the Apps Script editor (Run). It touches each permission the script needs, so Google asks for
// every one that is missing, and it logs which ones work. It reads nothing, sends nothing and takes no input.
function authorizeWorkPulse() {
  var steps = [
    ['your Sheet', function () { SpreadsheetApp.getActiveSpreadsheet().getName(); }],
    ['sending email', function () { MailApp.getRemainingDailyQuota(); }],
    ['the daily timer', function () { ScriptApp.getProjectTriggers(); }],
    ['your email address', function () { Session.getEffectiveUser().getEmail(); }],
    ['calling Gemini (optional: without it the standup uses plain wording)', function () {
      UrlFetchApp.fetch('https://generativelanguage.googleapis.com/', { muteHttpExceptions: true });
    }]
  ];
  var failed = 0;
  for (var i = 0; i < steps.length; i++) {
    try {
      steps[i][1]();
      Logger.log('OK      ' + steps[i][0]);
    } catch (err) {
      failed++;
      Logger.log('MISSING ' + steps[i][0] + ': ' + err);
    }
  }
  Logger.log(failed === 0 ? 'All permissions are in place. Now deploy a New version.' : failed + ' permission(s) missing. See the lines above.');
}

// ---- The daily send ----

// Run by the time trigger. It does nothing unless setEmail switched the email on, sends at most once per
// local date (lastEmailDate is set only after the mail went out), and only when the day has a log or a
// clock-in. google.script.run can call it too, so it never takes input and never sends anywhere but to
// the owner. The moment and the date are read once, so a run across local midnight stays on one date.
// With "when I clock out" (version 8) it sweeps the closed days instead, and never sends the fixed-time email.
function sendEveningEmail() {
  var res = withLock(function () {
    var props = PropertiesService.getScriptProperties();
    processDueDayEmails_();
    var settings = {};
    try {
      settings = JSON.parse(props.getProperty('email') || '{}') || {};
    } catch (err) {}
    if (settings.enabled !== true) return { sent: false };
    if (settings.when === 'clockout') return { sent: false, sweep: dueStandups_(new Date(), getMeta_(), settings) };
    var now = new Date();
    var meta = getMeta_();
    // Anyone with the link can call this function, so it only sends near the saved time. Calling it early
    // must not use up the day's once-a-day guard.
    if (!nearSavedTime_(now, settings, meta)) return { sent: false };
    var today = Utilities.formatDate(now, userTz_(meta), 'yyyy-MM-dd');
    if (props.getProperty('lastEmailDate') === today) return { sent: false };
    var mail = composeEmail_(false, now, meta);
    if (mail.skip) return { sent: false };
    sendMail_(mail);
    props.setProperty('lastEmailDate', today);
    return { sent: true };
  });
  if (!res.sweep) return res;
  // The writing (a Gemini call can take seconds) happens outside the lock, so the PC's pushes are not held up.
  return { sent: sweepStandups_(res.sweep) > 0 };
}

// True when now, on the clock of the saved zone, is within 45 minutes of the saved hour and minute.
function nearSavedTime_(now, settings, meta) {
  var tz = settings.tz && validZone_(settings.tz) ? settings.tz : userTz_(meta);
  var clock = Utilities.formatDate(now, tz, 'HH:mm').split(':');
  var nowMin = Number(clock[0]) * 60 + Number(clock[1]);
  var savedMin = Number(settings.hour) * 60 + Number(settings.minute);
  if (isNaN(savedMin)) return false;
  return Math.abs(nowMin - savedMin) <= 45;
}

// "a@x.com, b@y.com" as a cleaned comma-separated text; '' for none; null when any address is not valid or there are over 5.
function recipients_(text) {
  var parts = String(text).split(',');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var a = parts[i].replace(/^\s+|\s+$/g, '');
    if (a === '') continue;
    if (a.length > 200 || !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(a)) return null;
    out.push(a);
  }
  return out.length > 5 ? null : out.join(',');
}

// The script owner's address. Session.getEffectiveUser needs a permission some deployments never got, so when it is
// refused the owner of the Sheet is used (the Sheet permission is always there). '' when neither is known.
function ownerEmail_() {
  try {
    var me = Session.getEffectiveUser().getEmail();
    if (me) return me;
  } catch (err) {}
  try {
    var owner = SpreadsheetApp.getActiveSpreadsheet().getOwner();
    return owner ? owner.getEmail() : '';
  } catch (err2) {
    return '';
  }
}

// The mail goes from the Google account that owns the script, to the saved recipients or, with none saved, to that same account.
function sendMail_(mail) {
  var saved = {};
  try {
    saved = JSON.parse(PropertiesService.getScriptProperties().getProperty('email') || '{}') || {};
  } catch (err) {}
  var to = saved.to ? String(saved.to) : ownerEmail_();
  if (!to) {
    throw new Error('No address to send to. Type your email in the Send it to box in WorkPulse Settings and save.');
  }
  MailApp.sendEmail({ to: to, subject: mail.subject, htmlBody: mail.html, body: mail.text });
  return to;
}

// Reads the Sheet and builds the email for the date of now in the user's zone. extra (optional): { date: 'yyyy-MM-dd' for
// another day, standup: its standup text, when: 'clockout' for the email sent when the day closes, sheetUrl }.
function composeEmail_(isTest, now, meta, extra) {
  extra = extra || {};
  var tz = userTz_(meta);
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var today = isDateText_(extra.date) ? extra.date : Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var i;

  var tasks = [];
  var taskRows = readTab_('WorkPulse_Tasks');
  for (i = 0; i < taskRows.length; i++) {
    var t = taskRows[i];
    if (t[0] === '') continue;
    tasks.push({
      id: String(t[0]), title: String(t[1]), project: String(t[2]), projectId: String(t[3] || ''), dueDate: dateText_(t[4], ssTz),
      stage: String(t[5]), trackedMinutes: num_(t[6]), completedAt: isoText_(t[7])
    });
  }
  var logs = [];
  var logRows = readTab_('WorkPulse_Recent');
  for (i = 0; i < logRows.length; i++) {
    var l = logRows[i];
    if (l[0] === '') continue;
    logs.push({
      id: String(l[0]), date: dateText_(l[1], ssTz), time: timeText_(l[2], ssTz), project: String(l[3]),
      projectId: String(l[4]), description: String(l[5]), status: String(l[6]), minutes: num_(l[7]),
      subTasks: String(l[8] || '') === '' ? [] : String(l[8]).split('\n')
    });
  }
  var workday = null;
  var dayRows = readTab_('WorkPulse_Days');
  for (i = 0; i < dayRows.length; i++) {
    if (dateText_(dayRows[i][0], ssTz) === today) {
      workday = { clockIn: isoText_(dayRows[i][1]), clockOut: isoText_(dayRows[i][2]) };
    }
  }
  return buildEveningEmail({
    date: today,
    tz: tz,
    now: now.toISOString(),
    tasks: tasks,
    logs: logs,
    projects: projectList_(),
    workday: workday,
    workdayHours: meta.workdayHours || DEFAULT_WORKDAY_HOURS,
    pushedAt: meta.pushedAt || '',
    pendingPhoneCount: pendingItems_().length,
    isTest: isTest === true,
    standup: extra.standup || '',
    when: extra.when || '',
    sheetUrl: extra.sheetUrl || ''
  });
}

// ---- Standup emails (version 6) ----
//
// The standup text comes from the WorkPulse_Standups tab (saveHistory). What was sent, or is waiting for its one-off
// trigger, is kept in the Script Property emailLog: a list of { k: key, s: 's' sent | 'p' pending | 'f' failed, t: time
// (sent at, or due at, in ms), n: tries, e: why the last try failed, g: trigger id, d: true for a delayed send }. It is
// kept under 9 KB (the Script Property limit) by dropping the oldest sent entries first. A key is "kind|from|to"; a key
// is never sent twice.

var DAY_EMAIL_TRIES = 3;
var DAY_EMAIL_RETRY_MS = 10 * 60000;
var EMAIL_LOG_MAX = 8000;

function dayEmailLog_() {
  try {
    var list = JSON.parse(PropertiesService.getScriptProperties().getProperty('emailLog') || '[]');
    return isArray_(list) ? list : [];
  } catch (err) {
    return [];
  }
}

function saveDayEmailLog_(list) {
  // Oldest first. Over the limit: sent entries go first, then the oldest of the rest.
  var text = JSON.stringify(list);
  for (var pass = 0; pass < 2; pass++) {
    var i = 0;
    while (i < list.length && text.length > EMAIL_LOG_MAX) {
      if (pass === 0 && list[i].s !== 's') {
        i++;
        continue;
      }
      list.splice(i, 1);
      text = JSON.stringify(list);
    }
  }
  PropertiesService.getScriptProperties().setProperty('emailLog', text);
}

function dayEmailTriggerIds_() {
  var ids = {};
  var list = dayEmailLog_();
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].g) ids[list[i].g] = true;
  }
  return ids;
}

function dayEmailEntry_(list, key) {
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].k === key) return list[i];
  }
  return null;
}

// { kind, from, to, key } from a request: day takes date (or from), week takes from and to. null when it does not fit.
function dayEmailTarget_(c) {
  var kind = c.kind;
  if (kind !== 'day' && kind !== 'week') return null;
  var from = isDateText_(c.from) ? c.from : c.date;
  var to = kind === 'day' ? from : c.to;
  if (!isDateText_(from) || !isDateText_(to) || to < from) return null;
  return { kind: kind, from: from, to: to, key: kind + '|' + from + '|' + to };
}

function deleteTriggerById_(id) {
  if (!id) return;
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getUniqueId() === id) ScriptApp.deleteTrigger(all[i]);
  }
}

// The newest saved standup text for a target, or ''.
function standupText_(target) {
  return standupTexts_()[target.kind + '|' + target.from + '|' + target.to] || '';
}

// Every saved standup as { 'kind|from|to': newest text }, from one read of the tab.
function standupTexts_() {
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rows = readTab_('WorkPulse_Standups');
  var best = {};
  var bestAt = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var key = String(r[1]) + '|' + dateText_(r[2], ssTz) + '|' + dateText_(r[3], ssTz);
    var at = String(r[7] || r[6] || '');
    if (!Object.prototype.hasOwnProperty.call(bestAt, key) || at >= bestAt[key]) {
      best[key] = String(r[4] || '').replace(/^\s+|\s+$/g, '');
      bestAt[key] = at;
    }
  }
  return best;
}

function dayEmailMail_(target, text) {
  var sheetUrl = '';
  try {
    sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  } catch (err) {}
  // A day: the same designed email as the evening one, for that date, with the standup as its first section.
  if (target.kind === 'day') {
    return composeEmail_(false, new Date(), getMeta_(), { date: target.from, standup: text, when: 'clockout', sheetUrl: sheetUrl });
  }
  var subject = 'WorkPulse week standup · ' + dayText_(target.from, 'd MMM') + ' to ' + dayText_(target.to, 'd MMM');
  // A week reads "this week", not "today" (the day email keeps "today").
  text = String(text).replace(/completed today/gi, 'completed this week');
  var meta = getMeta_();
  var tz = userTz_(meta);
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var clocked = {};
  var dayRows = readTab_('WorkPulse_Days');
  for (var i = 0; i < dayRows.length; i++) {
    var dd = dateText_(dayRows[i][0], ssTz);
    if (dd < target.from || dd > target.to) continue;
    var cin = emailDate_(isoText_(dayRows[i][1]));
    if (cin) clocked[dd] = { cin: cin, cout: emailDate_(isoText_(dayRows[i][2])) };
  }
  var pushed = emailDate_(meta.pushedAt);
  // Time by project counts logged time only, not the done tasks the standup also uses.
  var all = rangeLogs_(target.from, target.to);
  var logs = [];
  for (var a = 0; a < all.length; a++) if (!all[a].fromTask) logs.push(all[a]);
  var logMinutes = 0;
  for (var l = 0; l < logs.length; l++) logMinutes += num_(logs[l].minutes);
  var html = weekEmailHtml_(weekModel_(target, clocked, num_(meta.workdayHours) > 0 ? num_(meta.workdayHours) : DEFAULT_WORKDAY_HOURS, {
    dataLine: pushed ? 'Data from your PC as of ' + Utilities.formatDate(pushed, tz, 'EEE d MMM') + ' at ' + clockTime_(pushed, tz) + '.' : 'No data from your PC yet.',
    dataOk: !!pushed, standup: text, groups: logGroups_(logs, projectList_()), projectColors: projectColors_(projectList_()), logMinutes: logMinutes, footer: 'Sent by your WorkPulse script.', sheetUrl: sheetUrl
  }));
  return { subject: subject, html: html, text: standupPlain_(text) + (sheetUrl ? '\n\nYour WorkPulse Sheet: ' + sheetUrl : '') };
}

// The week's figures from its clock-ins: { 'yyyy-MM-dd': { cin, cout } }. Pure, so the preview page can use it too.
function weekModel_(target, clocked, hoursPerDay, extra) {
  var perDay = Math.round(hoursPerDay * 60);
  var days = [];
  var worked = 0;
  var dayCount = 0;
  var openCount = 0;
  for (var d = target.from; d <= target.to; d = addDays_(d, 1)) {
    var c = clocked[d];
    var mins = c && c.cout ? Math.max(0, Math.floor((c.cout.getTime() - c.cin.getTime()) / 60000)) : 0;
    if (c) dayCount++;
    if (c && !c.cout) openCount++;
    worked += mins;
    days.push({ label: dayText_(d, 'EEE d'), worked: mins, open: !!(c && !c.cout), off: !c });
  }
  var w = {
    range: dayText_(target.from, 'd MMM') + ' to ' + dayText_(target.to, 'd MMM'), worked: worked, target: perDay * dayCount, perDay: perDay,
    days: days, dayCount: dayCount, openCount: openCount
  };
  for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) w[k] = extra[k];
  return w;
}


// ---- The Sheet's own standup emails (version 8) ----
//
// With "when I clock out" a timer runs sendEveningEmail every 15 minutes. It looks at the last few days in WorkPulse_Days
// (pushed by the PC seconds after a clock-out) and sends each day that is closed and has a log or a standup: at once when
// the PC's standup is there, else 10 minutes after the clock-out with a standup the Sheet writes itself. A day still open
// after its date (a forgotten clock-out) goes after midnight. A Thursday also sends the week (Friday to Thursday).
// The emailLog keys are the same as the PC's sendDayEmail, so a day is never sent twice, whoever sends it first.

var SWEEP_EVERY_MINUTES = 15;
var SWEEP_GRACE_MS = 10 * 60000;
var SWEEP_DAYS = 3;
var GEMINI_BUDGET_MS = 90000;
var GEMINI_SYSTEM = 'You turn raw task logs into a concise, human-ready work standup, without filler or marketing words. Follow the requested format exactly.';

// Day of the week of 'yyyy-MM-dd' (0 = Sunday, 4 = Thursday), with no zone involved.
function weekdayOf_(dateText) {
  var p = dateText.split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
}

// True when the sweep must leave this email alone: sent, waiting for its timer, or out of tries.
function sweepSkips_(entry) {
  if (!entry) return false;
  if (entry.s === 's' || entry.s === 'p') return true;
  return num_(entry.n) >= DAY_EMAIL_TRIES || entry.e === 'address';
}

// The emails due now, as [{ kind, from, to, key, text }] (text '' = none saved yet). Reads only; run under the lock.
function dueStandups_(now, meta, settings) {
  var tz = userTz_(meta);
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var oldest = addDays_(today, -SWEEP_DAYS);
  if (isDateText_(settings.since) && settings.since > oldest) oldest = settings.since;
  var i;
  var logDays = {};
  var logRows = readTab_('WorkPulse_Recent');
  for (i = 0; i < logRows.length; i++) {
    if (logRows[i][0] !== '') logDays[dateText_(logRows[i][1], ssTz)] = true;
  }
  var days = {};
  var dayRows = readTab_('WorkPulse_Days');
  for (i = 0; i < dayRows.length; i++) {
    var dd = dateText_(dayRows[i][0], ssTz);
    if (isDateText_(dd)) days[dd] = { clockIn: emailDate_(isoText_(dayRows[i][1])), clockOut: emailDate_(isoText_(dayRows[i][2])) };
  }
  var texts = standupTexts_();
  var list = dayEmailLog_();
  var phoneOuts = {};
  var po = phoneClockOuts_();
  for (i = 0; i < po.length; i++) phoneOuts[po[i].date] = po[i];
  var out = [];
  function add(kind, from, to, hasLogs, waitUntil) {
    var key = kind + '|' + from + '|' + to;
    var text = texts[key] || '';
    if (!hasLogs && text === '') return;
    if (text === '' && waitUntil && now.getTime() < waitUntil) return;
    if (sweepSkips_(dayEmailEntry_(list, key))) return;
    out.push({ kind: kind, from: from, to: to, key: key, text: text });
  }
  for (var d = oldest; d <= today; d = addDays_(d, 1)) {
    var w = days[d];
    if (!w || !w.clockIn) continue;
    // Closed: clocked out, or still open after its date. A clock-out waits a little for the PC's standup.
    if (!w.clockOut && d >= today) continue;
    var waitUntil = w.clockOut ? w.clockOut.getTime() + SWEEP_GRACE_MS : 0;
    if (w.clockOut) waitUntil = Math.max(waitUntil, phoneOutWaitUntil_(phoneOuts[d], w.clockOut));
    add('day', d, d, logDays[d] === true, waitUntil);
    if (weekdayOf_(d) === 4) {
      var from = addDays_(d, -6);
      var weekLogs = false;
      for (var x = from; x <= d; x = addDays_(x, 1)) if (logDays[x] === true) weekLogs = true;
      add('week', from, d, weekLogs, waitUntil);
    }
  }
  return out;
}

// A day closed from the phone (version 10) gives the PC time to send its own logs and standup first: until the PC has
// taken the clock-out, at most PHONE_OUT_WAIT_MS after it was made; once taken, the usual grace from that moment.
// 0 when the day's clock-out did not come from the phone.
var PHONE_OUT_WAIT_MS = 60 * 60000;
function phoneOutWaitUntil_(entry, clockOut) {
  if (!entry || entry.clockOut !== clockOut.toISOString()) return 0;
  if (entry.applied) return new Date(entry.applied).getTime() + SWEEP_GRACE_MS;
  return new Date(entry.at).getTime() + PHONE_OUT_WAIT_MS;
}

// Writes and sends the due emails. Returns how many went. A standup the Sheet wrote is saved to WorkPulse_Standups, so the
// email, the week and the Sheet show the same text; a standup from the PC later replaces it there (same id).
function sweepStandups_(targets) {
  var sent = 0;
  var deadline = new Date().getTime() + GEMINI_BUDGET_MS;
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var made = t.text === '' ? writeStandup_(t, deadline) : { text: t.text, writer: '' };
    if (made.text === '') continue;
    var res = tryLocked_(function () {
      var list = dayEmailLog_();
      var entry = dayEmailEntry_(list, t.key);
      if (sweepSkips_(entry)) return false;
      if (made.writer && standupText_(t) === '') {
        upsertByKey_('WorkPulse_Standups', [[t.kind === 'day' ? 'day:' + t.from : 'week:' + t.to, t.kind, t.from, t.to,
          made.text.slice(0, STANDUP_MAX), made.writer, new Date().toISOString(), '']]);
      }
      if (!entry) {
        entry = { k: t.key, s: 'f', t: 0, n: 0, e: '', g: '', q: 'sheet' };
        list.push(entry);
      }
      entry.d = false;
      attemptDayEmail_(list, entry);
      return entry.s === 's';
    });
    if (res.got && res.value) sent++;
  }
  return sent;
}

// What a standup is written from, as one list: the logs of a date range (WorkPulse_Recent, with their sub-tasks) and the
// tasks done in it (WorkPulse_Tasks) that no log already names. The same merge as standupEntries in src/utils/standup.ts.
function rangeLogs_(from, to) {
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var tz = userTz_(getMeta_());
  var rows = readTab_('WorkPulse_Recent');
  var out = [];
  var texts = {};
  for (var i = 0; i < rows.length; i++) {
    var l = rows[i];
    if (l[0] === '') continue;
    var date = dateText_(l[1], ssTz);
    if (date < from || date > to) continue;
    var description = String(l[5] || '');
    texts['k' + description.replace(/^\s+|\s+$/g, '').toLowerCase()] = true;
    out.push({
      date: date, time: timeText_(l[2], ssTz), project: String(l[3] || '') || 'No project', projectId: String(l[4] || ''), description: description,
      status: String(l[6] || ''), minutes: num_(l[7]), subTasks: String(l[8] || '') === '' ? [] : String(l[8]).split('\n')
    });
  }
  var tasks = readTab_('WorkPulse_Tasks');
  for (var j = 0; j < tasks.length; j++) {
    var t = tasks[j];
    if (t[0] === '' || String(t[5]) !== 'done') continue;
    var day = emailLocalDate_(isoText_(t[7]), tz) || dateText_(t[4], ssTz);
    var title = String(t[1] || '');
    if (!day || day < from || day > to || texts['k' + title.replace(/^\s+|\s+$/g, '').toLowerCase()]) continue;
    out.push({ date: day, time: '', project: String(t[2] || '') || 'No project', projectId: String(t[3] || ''), description: title, status: 'completed', minutes: num_(t[6]), subTasks: [], fromTask: true });
  }
  return out;
}

// { text, writer }: Gemini when it answers, else plain wording. Never throws for a Gemini problem.
function writeStandup_(t, deadline) {
  var logs = rangeLogs_(t.from, t.to);
  if (logs.length === 0) return { text: '', writer: '' };
  var ai = '';
  try {
    ai = geminiStandup_(standupPrompt_(t, logs), deadline);
  } catch (err) {
    ai = '';
  }
  if (ai) return { text: ai, writer: 'gemini' };
  return { text: templateStandup_(t, logs), writer: 'template' };
}

// The same instructions as the app's writer (src/utils/aiGenerator.ts), so a standup reads the same whoever wrote it.
function standupPrompt_(t, logs) {
  var lines = [];
  for (var i = 0; i < logs.length && i < 80; i++) {
    var l = logs[i];
    var subs = '';
    for (var s = 0; s < l.subTasks.length && s < 8; s++) subs += '\n   - ' + String(l.subTasks[s]).slice(0, 160);
    lines.push((i + 1) + '. [' + l.status.toUpperCase() + '] [Project: ' + l.project + '] ' + (t.kind === 'week' ? l.date + ' ' : '') +
      l.description.slice(0, 300) + (l.minutes ? ' (' + l.minutes + 'm)' : '') + subs);
  }
  var when = t.kind === 'week' ? 'this week' : 'today';
  return 'Please generate a work report based on these logged tasks:\n\n--- LOGGED WORK ENTRIES ---\n' + lines.join('\n') +
    '\n---------------------------\n\nCovers: ' + (t.kind === 'week' ? 'the week ' + t.from + ' to ' + t.to : t.from) +
    '\n\nTarget Format: A clean, professional Slack/Teams standup update with exactly three sections. Use plain bold headings with no emoji. ' +
    'Under each heading write short bullets, one per piece of work, starting with the project name in bold (for example "- *project:* what was done"). ' +
    'Logs and done tasks are one list: merge entries about the same work into one bullet. When a piece of work has notable steps (the entry\'s ' +
    'sub-tasks), list up to four of them as sub-points under its bullet, each on its own line starting with two spaces and "- " (for example ' +
    '"  - added the outbox table"). No filler and no exclamation marks. The sections are:\n*What I completed ' + when + ':*\n' +
    '*In progress / Rolling over:*\n*Blockers / Waiting on:*\nTone: casual\n\nGenerate the final message text now. Output it directly, with no code fence.';
}

// The standup in plain wording, in the shared format (generateFallbackTemplate in aiGenerator.ts): one point per entry, its
// project first, up to four sub-tasks as indented sub-points.
function templateStandup_(t, logs) {
  function point(l) {
    var out = '- *' + (l.project.replace(/[*:]/g, '') || 'General') + ':* ' + l.description.replace(/\*/g, '').replace(/\s+/g, ' ');
    for (var s = 0; s < l.subTasks.length && s < 4; s++) out += '\n  - ' + String(l.subTasks[s]).replace(/\*/g, '').replace(/\s+/g, ' ');
    return out;
  }
  var done = [];
  var going = [];
  var blocked = [];
  for (var i = 0; i < logs.length; i++) {
    if (logs[i].status === 'in_progress') going.push(point(logs[i]));
    else if (logs[i].status === 'blocked') blocked.push(point(logs[i]));
    else done.push(point(logs[i]));
  }
  return '*What I completed ' + (t.kind === 'week' ? 'this week' : 'today') + ':*\n' + (done.length ? done.join('\n') : '- None') +
    '\n\n*In progress / Rolling over:*\n' + (going.length ? going.join('\n') : '- None') +
    '\n\n*Blockers / Waiting on:*\n' + (blocked.length ? blocked.join('\n') : '- None');
}

// The standup from Gemini with the saved key, trying each model in turn, or '' (no key, no permission, rate limit, bad
// answer, or the time budget used up). A rate limit or server error moves on to the next model; a refused key stops.
function geminiStandup_(prompt, deadline) {
  var key = PropertiesService.getScriptProperties().getProperty('geminiKey');
  if (!key) return '';
  var body = JSON.stringify({
    systemInstruction: { parts: [{ text: GEMINI_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  });
  for (var i = 0; i < GEMINI_MODELS.length; i++) {
    if (new Date().getTime() >= deadline) return '';
    var res;
    try {
      res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODELS[i] + ':generateContent', {
        method: 'post', contentType: 'application/json', payload: body, headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
      });
    } catch (err) {
      return '';
    }
    var code = res.getResponseCode();
    if (code === 200) {
      var text = geminiText_(res.getContentText());
      if (text) return text;
    } else if (code === 401 || code === 403) {
      return '';
    }
  }
  return '';
}

function geminiText_(raw) {
  try {
    var data = JSON.parse(raw);
    var parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    if (!isArray_(parts)) return '';
    var text = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && typeof parts[i].text === 'string' && parts[i].thought !== true) text += parts[i].text;
    }
    text = text.replace(/^\s*\x60\x60\x60[a-z]*\s*\n?/i, '').replace(/\n?\s*\x60\x60\x60\s*$/, '').replace(/^\s+|\s+$/g, '');
    return text.slice(0, STANDUP_MAX);
  } catch (err) {
    return '';
  }
}

// One send try for an entry. The try is counted and saved before the mail goes, so a crash cannot hide a try.
// Success: sent. Failure: the reason is kept; a delayed entry gets one new timer until its tries run out.
function attemptDayEmail_(list, entry) {
  var parts = entry.k.split('|');
  var text = standupText_({ kind: parts[0], from: parts[1], to: parts[2] });
  deleteTriggerById_(entry.g);
  entry.g = '';
  entry.s = 'f';
  if (text === '') {
    entry.e = 'empty';
    saveDayEmailLog_(list);
    return;
  }
  entry.n = num_(entry.n) + 1;
  saveDayEmailLog_(list);
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('quota: no emails left today');
    sendMail_(dayEmailMail_({ kind: parts[0], from: parts[1], to: parts[2] }, text));
    entry.s = 's';
    entry.t = new Date().getTime();
    entry.e = '';
  } catch (err) {
    var why = String(err);
    entry.e = /quota|too many times|limit/i.test(why) ? 'quota' : /No address/.test(why) ? 'address' : 'mail';
    if (entry.d === true && entry.n < DAY_EMAIL_TRIES && entry.e !== 'address') {
      try {
        var tr = ScriptApp.newTrigger(EMAIL_FN).timeBased().after(DAY_EMAIL_RETRY_MS).create();
        entry.g = tr.getUniqueId();
        entry.s = 'p';
        entry.t = new Date().getTime() + DAY_EMAIL_RETRY_MS;
      } catch (err2) {}
    }
  }
  saveDayEmailLog_(list);
}

// Sends the delayed standup emails that are due, and removes timers nothing waits for. Run by sendEveningEmail under
// the lock, so the one-off timers (whose handler is sendEveningEmail) do their work through it.
function processDueDayEmails_() {
  var list = dayEmailLog_();
  var now = new Date().getTime();
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e && e.s === 'p' && e.d === true && num_(e.t) - 30000 <= now) attemptDayEmail_(list, e);
  }
  var keep = {};
  for (var j = 0; j < list.length; j++) {
    if (list[j] && list[j].s === 'p' && list[j].g) keep[list[j].g] = true;
  }
  var all = ScriptApp.getProjectTriggers();
  var ids = dayEmailTriggerIds_();
  for (var k = 0; k < all.length; k++) {
    var id = all[k].getUniqueId();
    if (all[k].getHandlerFunction() === EMAIL_FN && ids[id] === true && keep[id] !== true) ScriptApp.deleteTrigger(all[k]);
  }
}

function dayEmailState_(e) {
  return e.s === 's' ? 'sent' : e.s === 'p' ? 'pending' : 'failed';
}

function dayEmailInfo_(e) {
  var info = { key: e.k, state: dayEmailState_(e), tries: num_(e.n) };
  if (e.s === 's') info.sentAt = new Date(num_(e.t)).toISOString();
  if (e.s === 'p') info.sendAt = new Date(num_(e.t)).toISOString();
  if (e.e) info.error = e.e;
  if (e.s === 'f') info.willRetry = num_(e.n) < DAY_EMAIL_TRIES && e.e !== 'empty' && e.e !== 'address';
  return info;
}

var DAY_EMAIL_FAIL_TEXT = {
  quota: 'Google has reached its daily limit for sending email from your account. Try again tomorrow.',
  address: 'There is no address to send to. Type your email in the Send it to box in WorkPulse Settings and save.',
  empty: 'There is no standup text to send.',
  mail: 'Google could not send the email just now.'
};

// { token, kind: 'day' | 'week', date | from + to, delayMinutes?, requestId? }: the standup text and a link to the Sheet, from the
// owner's Gmail. Sent at most once per key. With delayMinutes above 0 a one-off timer sends it later (cancelDayEmail stops it).
// No standup text for the key: nothing is sent and the state is "skipped".
function sendDayEmailAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  var target = dayEmailTarget_(c);
  if (!target) return badRequest_('The standup email needed a day, or a first and last day of the week.');
  var delay = c.delayMinutes == null ? 0 : Number(c.delayMinutes);
  if (!isFinite(delay) || delay < 0 || delay > 24 * 60) return badRequest_('The delay must be between 0 and 1440 minutes.');
  var res = tryLocked_(function () {
    var list = dayEmailLog_();
    var entry = dayEmailEntry_(list, target.key);
    if (entry && entry.s === 's') return { status: 'ok', state: 'sent', key: target.key, duplicate: true };
    if (entry && entry.s === 'p') return { status: 'ok', state: 'pending', key: target.key, duplicate: true, sendAt: new Date(num_(entry.t)).toISOString() };
    if (entry && num_(entry.n) >= DAY_EMAIL_TRIES) {
      return { status: 'error', code: 'mail_failed', message: DAY_EMAIL_FAIL_TEXT[entry.e] || DAY_EMAIL_FAIL_TEXT.mail, key: target.key, state: 'failed' };
    }
    if (standupText_(target) === '') return { status: 'ok', state: 'skipped', key: target.key, reason: 'empty' };
    if (!entry) {
      entry = { k: target.key, s: 'f', t: 0, n: 0, e: '', g: '', q: str_(c.requestId).slice(0, 40) };
      list.push(entry);
    }
    if (delay > 0) {
      var ms = Math.max(60000, Math.round(delay * 60000));
      var tr;
      try {
        tr = ScriptApp.newTrigger(EMAIL_FN).timeBased().after(ms).create();
      } catch (err) {
        return { status: 'error', code: 'error', message: 'The Sheet script could not set up the timer. Redeploy the script and allow the permissions Google asks for.', key: target.key };
      }
      entry.d = true;
      entry.s = 'p';
      entry.t = new Date().getTime() + ms;
      entry.g = tr.getUniqueId();
      saveDayEmailLog_(list);
      return { status: 'ok', state: 'pending', key: target.key, sendAt: new Date(entry.t).toISOString() };
    }
    entry.d = false;
    attemptDayEmail_(list, entry);
    var info = dayEmailInfo_(entry);
    if (entry.s === 's') return { status: 'ok', state: 'sent', key: target.key, sentAt: info.sentAt };
    return { status: 'error', code: 'mail_failed', message: DAY_EMAIL_FAIL_TEXT[entry.e] || DAY_EMAIL_FAIL_TEXT.mail, key: target.key, state: 'failed', tries: info.tries, willRetry: info.willRetry };
  });
  return res.got ? res.value : busyAnswer_();
}

// { token, keys?: string[] }: sent / pending / failed for each key that has an entry (all entries when no keys are given).
function emailStatusAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  if (c.keys != null && !isArray_(c.keys)) return badRequest_();
  var list = dayEmailLog_();
  var items = [];
  var i;
  if (c.keys == null) {
    for (i = 0; i < list.length; i++) items.push(dayEmailInfo_(list[i]));
  } else {
    for (i = 0; i < c.keys.length && i < 200; i++) {
      var e = dayEmailEntry_(list, String(c.keys[i]));
      if (e) items.push(dayEmailInfo_(e));
    }
  }
  return { status: 'ok', items: items };
}

// { token, kind, date | from + to }: stops a waiting standup email (its timer is removed). A sent email stays sent.
function cancelDayEmailAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  var target = dayEmailTarget_(c);
  if (!target) return badRequest_('The standup email needed a day, or a first and last day of the week.');
  var res = tryLocked_(function () {
    var list = dayEmailLog_();
    var entry = dayEmailEntry_(list, target.key);
    if (!entry) return { status: 'ok', cancelled: false, state: 'none', key: target.key };
    if (entry.s !== 'p') return { status: 'ok', cancelled: false, state: dayEmailState_(entry), key: target.key };
    deleteTriggerById_(entry.g);
    list.splice(list.indexOf(entry), 1);
    saveDayEmailLog_(list);
    return { status: 'ok', cancelled: true, state: 'none', key: target.key };
  });
  return res.got ? res.value : busyAnswer_();
}

// ---- The email itself (pure) ----

// data = { date, tz, now, tasks, logs, workday, workdayHours, pushedAt, pendingPhoneCount, projects?, isTest? }
// now (an ISO text or a Date) is the moment the email is for; the function reads no clock itself.
// Returns { skip, subject, html, text }. skip is true when the day has no log and no clock-in.
function buildEveningEmail(data) {
  var date = data.date;
  var tz = data.tz;
  var now = emailDate_(data.now);
  var i;

  var logs = [];
  var all = data.logs || [];
  for (i = 0; i < all.length; i++) {
    if (all[i] && all[i].date === date) logs.push(all[i]);
  }
  var logMinutes = 0;
  for (i = 0; i < logs.length; i++) logMinutes += num_(logs[i].minutes);

  var clockIn = emailDate_(data.workday && data.workday.clockIn);
  var clockOut = emailDate_(data.workday && data.workday.clockOut);
  var noData = logs.length === 0 && !clockIn;

  var pushed = emailDate_(data.pushedAt);
  var pushedToday = !!pushed && Utilities.formatDate(pushed, tz, 'yyyy-MM-dd') === date;

  // Worked time is the clocked time; with no clock-in it is the logged time. While still clocked in it runs
  // to now, but never past the last data from the PC (a PC that stopped sending would otherwise look like
  // hours of work), and with no data from today at all it falls back to the logged time.
  var worked = logMinutes;
  if (clockIn) {
    var end = null;
    if (clockOut) end = clockOut;
    else if (pushedToday) end = now && now.getTime() < pushed.getTime() ? now : pushed;
    if (end) worked = Math.max(0, Math.floor((end.getTime() - clockIn.getTime()) / 60000));
  }
  var hours = num_(data.workdayHours) > 0 ? num_(data.workdayHours) : DEFAULT_WORKDAY_HOURS;
  var target = Math.round(hours * 60);

  var clockLine;
  if (!clockIn) clockLine = 'not clocked in';
  else if (clockOut) clockLine = 'In ' + clockTime_(clockIn, tz) + ' \u00b7 Out ' + clockTime_(clockOut, tz);
  else clockLine = 'In ' + clockTime_(clockIn, tz) + ' \u00b7 still clocked in';

  var dataLine;
  if (data.when === 'clockout' && pushed) {
    // A closed day's email can go out later (by the Sheet, or caught up): it names when the PC last sent data.
    dataLine = 'Data from your PC as of ' + Utilities.formatDate(pushed, tz, 'EEE d MMM') + ' at ' + clockTime_(pushed, tz) + '.';
  } else if (pushedToday) {
    dataLine = 'Data from your PC as of ' + clockTime_(pushed, tz) + '.';
  } else {
    dataLine = 'No data from your PC today.';
    if (pushed) dataLine += ' The last data came on ' + Utilities.formatDate(pushed, tz, 'EEE d MMM') + ' at ' + clockTime_(pushed, tz) + '.';
  }

  var groups = logGroups_(logs, data.projects || []);

  var done = [];
  var open = [];
  var tasks = data.tasks || [];
  for (i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!t) continue;
    if (t.stage === 'done') {
      if (emailLocalDate_(t.completedAt, tz) === date) done.push(t);
    } else {
      open.push(t);
    }
  }
  // Each task row carries its project's colour (by id, else by name), like the log rows.
  var colorById = {};
  var colorByName = {};
  var plist = data.projects || [];
  for (i = 0; i < plist.length; i++) {
    colorById['k' + plist[i].id] = plist[i].color;
    colorByName['k' + plist[i].name] = plist[i].color;
  }
  function withColor(t) {
    var c = colorById['k' + (t.projectId || '')] || colorByName['k' + (t.project || '')];
    var copy = {};
    for (var key in t) if (Object.prototype.hasOwnProperty.call(t, key)) copy[key] = t[key];
    copy.color = safeColor_(c);
    return copy;
  }
  for (i = 0; i < done.length; i++) done[i] = withColor(done[i]);
  for (i = 0; i < open.length; i++) open[i] = withColor(open[i]);
  var openGroups = openTaskGroups_(open, date);

  var pending = num_(data.pendingPhoneCount);
  var pendingLine = pending > 0
    ? pending + (pending === 1 ? ' task added on your phone is' : ' tasks added on your phone are') + ' not on your PC yet.'
    : '';

  var dayShort = dayText_(date, 'EEE d MMM');
  var dayLong = dayText_(date, 'EEEE d MMMM');
  var subject = noData
    ? 'WorkPulse \u00b7 ' + dayShort + ' \u00b7 no data yet'
    : 'WorkPulse \u00b7 ' + dayShort + ' \u00b7 ' + fmtHM_(worked) + ' worked \u00b7 ' + logs.length + (logs.length === 1 ? ' log' : ' logs');

  var footer = data.when === 'clockout'
    ? 'Sent by your WorkPulse script when your day closed' + (now ? ', at ' + clockTime_(now, tz) : '') + ' (' + tz +
      '). Change when it arrives, or turn it off, in WorkPulse Settings \u2192 Phone & evening email.'
    : (data.isTest ? 'This is a test email. ' : '') + 'Sent by your WorkPulse script' + (now ? ' at ' + clockTime_(now, tz) : '') + ' (' + tz +
      '). Change the time or turn it off in WorkPulse Settings \u2192 Phone & evening email.';
  var standup = String(data.standup || '').replace(/^\s+|\s+$/g, '');

  var model = {
    dayLong: dayLong, noData: noData, worked: worked, target: target, clockLine: clockLine, dataLine: dataLine, dataOk: pushedToday || (data.when === 'clockout' && !!pushed),
    groups: groups, logCount: logs.length, logMinutes: logMinutes, done: done, openGroups: openGroups,
    openCount: open.length, pendingLine: pendingLine, footer: footer, standup: standup, projectColors: projectColors_(data.projects), sheetUrl: String(data.sheetUrl || '')
  };
  return { skip: noData && standup === '', subject: subject, html: emailHtml_(model), text: emailText_(model) };
}

// ---- Pieces ----

function emailDate_(iso) {
  if (!iso) return null;
  var d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function clockTime_(d, tz) {
  return Utilities.formatDate(d, tz, 'HH:mm');
}

function emailLocalDate_(iso, tz) {
  var d = emailDate_(iso);
  return d ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : '';
}

// Minutes as H:MM.
function fmtHM_(minutes) {
  var m = Math.max(0, Math.round(minutes));
  var rest = m % 60;
  return Math.floor(m / 60) + ':' + (rest < 10 ? '0' : '') + rest;
}

// A 'yyyy-MM-dd' text in a pattern, with no zone shift.
function dayText_(dateText, pattern) {
  var p = dateText.split('-');
  return Utilities.formatDate(new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))), 'UTC', pattern);
}

function dayLabel_(d, today) {
  if (!isDateText_(d)) return d ? d : 'No date';
  if (d === today) return 'Today';
  if (d === addDays_(today, -1)) return 'Yesterday';
  if (d === addDays_(today, 1)) return 'Tomorrow';
  return dayText_(d, 'EEE d MMM');
}

function esc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// User text in the plain-text body: one line, and no angle brackets that could read as markup.
function plain_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/</g, '\u2039').replace(/>/g, '\u203a');
}

function safeColor_(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#9aa59f';
}

// Logs by project, biggest project first, each project's logs by time.
function logGroups_(logs, projects) {
  var colors = {};
  for (var p = 0; p < projects.length; p++) colors['k' + projects[p].id] = projects[p].color;
  var groups = [];
  var index = {};
  var i;
  for (i = 0; i < logs.length; i++) {
    var name = String(logs[i].project || '') || 'No project';
    var key = 'k' + name;
    if (!index.hasOwnProperty(key)) {
      index[key] = groups.length;
      groups.push({ name: name, color: safeColor_(colors['k' + logs[i].projectId]), minutes: 0, logs: [], order: groups.length });
    }
    var g = groups[index[key]];
    g.minutes += num_(logs[i].minutes);
    g.logs.push(logs[i]);
  }
  for (i = 0; i < groups.length; i++) {
    groups[i].logs.sort(function (a, b) {
      return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
    });
  }
  groups.sort(function (a, b) {
    return b.minutes - a.minutes || a.order - b.order;
  });
  return groups;
}

// Open tasks by due date: today, then earlier days newest first, then later days, then no date.
function openTaskGroups_(open, today) {
  var byDate = {};
  var dates = [];
  for (var i = 0; i < open.length; i++) {
    var d = isDateText_(open[i].dueDate) ? open[i].dueDate : '';
    if (!byDate.hasOwnProperty('k' + d)) {
      byDate['k' + d] = [];
      dates.push(d);
    }
    byDate['k' + d].push(open[i]);
  }
  function rank(d) {
    if (d === '') return 3;
    if (d === today) return 0;
    return d < today ? 1 : 2;
  }
  dates.sort(function (a, b) {
    var ra = rank(a);
    var rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return a < b ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  var out = [];
  for (var j = 0; j < dates.length; j++) {
    out.push({ label: dayLabel_(dates[j], today), tasks: byDate['k' + dates[j]] });
  }
  return out;
}

// Project and tracked time of a task, as text ('' when there is nothing to say).
function taskMetaParts_(task, withProject) {
  var parts = [];
  if (withProject && task.project) parts.push(task.project);
  if (num_(task.trackedMinutes) > 0) parts.push(fmtHM_(num_(task.trackedMinutes)) + ' tracked');
  return parts;
}

function taskMeta_(task, withProject) {
  var parts = taskMetaParts_(task, withProject);
  return parts.length ? ' <span style="color:#5d6b63">&middot; ' + esc_(parts.join(' · ')) + '</span>' : '';
}

function taskMetaText_(task, withProject) {
  var parts = taskMetaParts_(task, withProject);
  return parts.length ? ' · ' + plain_(parts.join(' · ')) : '';
}

function stageNote_(task) {
  if (task.stage === 'blocked') return 'blocked';
  if (task.stage === 'paused') return 'paused';
  if (task.stage === 'in_progress') return 'in progress';
  return '';
}

// ---- HTML (inline styles only) ----

// Design (version 9): the references in docs/email-designs/ (Main = clock-out, Week, Evening, Empty = test with no data,
// Phone = clock-out at 390 px), built from the app's Chase tokens: page #f4f1e8, card white with #e3ddcd, text #1d2b24 and
// #5d6b63, rules #ebe7dc, band #0f3d2e with #f2b705 for the hours. Email-safe: tables and inline styles; the <style> in the
// head only adds hover and the phone sizes (classes wrap, hero, hn, card, sn, sc).
var EM_FONT = "Archivo,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
var EM_INK = '#1d2b24';
var EM_MUTED = '#5d6b63';
var EM_FAINT = '#6b776f';
var EM_LINE = '#ebe7dc';
var EM_RULE = '1px solid ' + EM_LINE;
var EM_TINT = '#f4f1e8';
var EM_NUM = 'font-variant-numeric:tabular-nums';
var EM_PAD = '24px';
var EM_OK = '#047857';
var EM_WARN = '#b45309';
var EM_BAD = '#be123c';
var EM_OPEN_MAX = 5;
var EM_LABEL = 'letter-spacing:.12em;text-transform:uppercase;font-weight:bold;color:#afbbb0';
var EM_HEAD_STYLE = 'body{margin:0}a{color:#0f3d2e}a:hover{color:#2a5546}' +
  '@media (max-width:480px){.wrap{padding:12px 8px 24px!important}.hero{padding:24px 20px!important}.hn{font-size:48px!important}' +
  '.card{padding:18px 16px!important}.sn{font-size:24px!important}.sc{padding-left:12px!important}}';

// The page and the card; rows is the HTML of the card's table rows. preheader is the inbox preview line (hidden).
function emailShell_(rows, preheader) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>WorkPulse</title><style>' + EM_HEAD_STYLE + '</style></head>' +
    '<body style="margin:0;background:' + EM_TINT + '">' +
    (preheader ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' + esc_(preheader) + '</div>' : '') +
    '<div class="wrap" style="width:100%;max-width:700px;box-sizing:border-box;margin:0 auto;background:' + EM_TINT + ';padding:28px 30px 36px;' +
    'font-family:' + EM_FONT + ';color:' + EM_INK + '">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#ffffff;border:1px solid #e3ddcd;border-radius:14px;overflow:hidden">' +
    rows + '</table></div></body></html>';
}

// The green top. hero: the big figure (a time) or null for a sentence (noData); heroNote beside it; pct (0-100) for the bar
// or null; under it either clock cells [{ label, value, open }] or a line of text.
function headerRow_(kicker, hero, heroNote, pct, cells, line) {
  var h = '<tr><td class="hero" style="background:#0f3d2e;padding:30px ' + EM_PAD + ' 30px">' +
    '<div style="font-size:12px;' + EM_LABEL + ';letter-spacing:.14em">' + kicker + '</div>';
  h += '<div style="margin-top:14px;' + EM_NUM + '"><span class="hn" style="font-size:60px;line-height:1;font-weight:bold;color:#f2b705;letter-spacing:-.02em">' +
    hero + '</span>' + (heroNote ? '<span style="font-size:17px;color:#f4f1e8;margin-left:12px">' + heroNote + '</span>' : '') + '</div>';
  if (pct !== null) h += meter_(pct, '#f2b705', '#2a5546', 8, 20, 6);
  if (cells && cells.length) {
    var tds = [];
    for (var i = 0; i < cells.length; i++) {
      tds.push('<td' + (i < cells.length - 1 ? ' style="padding-right:36px"' : '') + '><div style="font-size:11px;' + EM_LABEL + '">' + cells[i].label + '</div>' +
        '<div style="margin-top:3px;font-size:18px;font-weight:bold;color:' + (cells[i].open ? '#f2b705' : '#f4f1e8') + (cells[i].open ? '' : ';' + EM_NUM) + '">' +
        cells[i].value + '</div></td>');
    }
    h += '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px"><tr>' + tds.join('') + '</tr></table>';
  } else if (line) {
    h += '<div style="margin-top:20px;font-size:15px;font-weight:bold;color:#f4f1e8">' + line + '</div>';
  }
  return h + '</td></tr>';
}

// The no-data header: the day, a sentence in place of the hours, and why.
function headerEmptyRow_(kicker, title, line) {
  return '<tr><td class="hero" style="background:#0f3d2e;padding:30px ' + EM_PAD + ' 30px">' +
    '<div style="font-size:12px;' + EM_LABEL + ';letter-spacing:.14em">' + kicker + '</div>' +
    '<div style="margin-top:14px;font-size:44px;line-height:1.1;font-weight:bold;color:#f2b705;letter-spacing:-.02em">' + title + '</div>' +
    '<div style="margin-top:16px;font-size:16px;line-height:1.5;color:#f4f1e8">' + line + '</div></td></tr>';
}

// A bar filled to pct (0-100).
function meter_(pct, fill, track, height, top, radius) {
  var p = Math.max(0, Math.min(100, Math.round(pct)));
  var cell = 'height:' + height + 'px;font-size:0;line-height:0';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="' + (top ? 'margin-top:' + top + 'px;' : '') +
    'border-radius:' + radius + 'px;overflow:hidden"><tr>' +
    (p > 0 ? '<td width="' + p + '%" style="' + cell + ';background:' + fill + '">&nbsp;</td>' : '') +
    (p < 100 ? '<td style="' + cell + ';background:' + track + '">&nbsp;</td>' : '') +
    '</tr></table>';
}

// The row of three figures under the header: [{ value, label }].
// The task tiles show only on a day that has done or open tasks; a day of logs alone shows what the logs did.
function usesTasks_(m) {
  return m.done.length > 0 || m.openCount > 0;
}

// Each log counts its sub-tasks, or 1 when it has none.
function thingsDone_(groups) {
  var n = 0;
  for (var g = 0; g < groups.length; g++) {
    for (var k = 0; k < groups[g].logs.length; k++) n += Math.max(1, (groups[g].logs[k].subTasks || []).length);
  }
  return n;
}

function statsRow_(items) {
  var cells = [];
  for (var i = 0; i < items.length; i++) {
    cells.push('<td' + (i ? ' class="sc"' : '') + ' width="' + (i ? '33%' : '34%') + '" valign="top" style="padding:22px 0' + (i ? ' 22px 20px;border-left:' + EM_RULE : '') + '">' +
      '<div class="sn" style="font-size:28px;line-height:1.1;font-weight:bold;' + EM_NUM + '">' + items[i].value + '</div>' +
      '<div style="font-size:13px;color:' + EM_MUTED + ';margin-top:5px">' + items[i].label + '</div></td>');
  }
  return '<tr><td style="padding:0 ' + EM_PAD + ';border-bottom:' + EM_RULE + '"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    cells.join('') + '</tr></table></td></tr>';
}

// "Long text" cut at a word to about n characters, with an ellipsis.
function clip_(text, n) {
  var t = String(text || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (t.length <= n) return t;
  var cut = t.slice(0, n - 1).replace(/\s+\S*$/, '');
  return (cut || t.slice(0, n - 1)) + '…';
}

// A section title (20 px) with an optional figure on the right. top: space above (34 for the first section, else 36);
// list: true for the task lists, whose rows start with their own rule (less space below).
function sectionHead_(title, aside, top, list) {
  var pad = 'padding:' + top + 'px ' + EM_PAD + ' ' + (list ? '6px' : '14px');
  if (!aside) return '<tr><td style="' + pad + '"><div style="font-size:20px;line-height:1.3;font-weight:bold">' + title + '</div></td></tr>';
  return '<tr><td style="' + pad + '"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="font-size:20px;line-height:1.3;font-weight:bold">' + title + '</td>' +
    '<td align="right" style="font-size:14px;font-weight:bold;color:' + EM_MUTED + ';white-space:nowrap;' + EM_NUM + '">' + aside + '</td>' +
    '</tr></table></td></tr>';
}

function sectionBody_(html) {
  return '<tr><td style="padding:0 ' + EM_PAD + '">' + html + '</td></tr>';
}

function chip_(color, size, gap) {
  return '<span style="display:inline-block;width:' + size + 'px;height:' + size + 'px;border-radius:2px;background:' + safeColor_(color) +
    ';margin-right:' + gap + 'px"></span>';
}

// Time per project: one bar split by project (two or more projects), and the legend with each project's time.
function splitBar_(groups) {
  var total = 0;
  for (var i = 0; i < groups.length; i++) total += num_(groups[i].minutes);
  if (total <= 0) return '';
  var cells = [];
  var legend = [];
  for (var g = 0; g < groups.length; g++) {
    var w = Math.max(1, Math.round((num_(groups[g].minutes) / total) * 100));
    cells.push('<td width="' + w + '%" style="height:12px;font-size:0;line-height:0;background:' + safeColor_(groups[g].color) +
      (g > 0 ? ';border-left:2px solid #ffffff' : '') + '">&nbsp;</td>');
    legend.push('<span style="display:inline-block;margin:0 22px 8px 0;white-space:nowrap;font-size:14px">' + chip_(groups[g].color, 10, 8) +
      esc_(groups[g].name) + '<span style="color:' + EM_MUTED + ';margin-left:8px;font-weight:bold;' + EM_NUM + '">' + esc_(fmtHM_(groups[g].minutes)) + '</span></span>');
  }
  var bar = groups.length < 2 ? '' : '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:6px;overflow:hidden;margin-bottom:16px"><tr>' +
    cells.join('') + '</tr></table>';
  // A line break between items, as in the references: it renders as the small space between them.
  return bar + '<div>' + legend.join('\n') + '</div>';
}

// The logs in short (evening email, no standup): one line each, its project's colour, its minutes. No sub-tasks.
function compactLogs_(groups) {
  var rows = [];
  for (var g = 0; g < groups.length; g++) {
    for (var k = 0; k < groups[g].logs.length; k++) {
      var lg = groups[g].logs[k];
      rows.push('<tr><td width="20" valign="top" style="padding:15px 0;border-top:' + EM_RULE + '"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' +
        safeColor_(groups[g].color) + ';margin-top:5px"></span></td>' +
        '<td valign="top" style="padding:14px 12px 14px 0;border-top:' + EM_RULE + ';font-size:15px;line-height:1.55">' + esc_(clip_(lg.description, 110)) + '</td>' +
        '<td valign="top" align="right" style="padding:14px 0;border-top:' + EM_RULE + ';font-size:14px;font-weight:bold;line-height:1.55;white-space:nowrap;' + EM_NUM + '">' +
        esc_(fmtHM_(num_(lg.minutes))) + '</td></tr>');
    }
  }
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px">' + rows.join('') + '</table>';
}

// A stage as a pill: amber for paused and in progress, red for blocked.
function stagePill_(task) {
  var note = stageNote_(task);
  if (!note) return '';
  var bad = task.stage === 'blocked';
  return '<span style="display:inline-block;padding:1px 9px;border-radius:10px;background:' + (bad ? '#fbe4e4' : '#fdf0dc') + ';color:' + (bad ? '#a8252c' : '#7a3e0c') +
    ';font-size:12px;font-weight:bold">' + esc_(note) + '</span>';
}

// A task row: a mark (done check, open ring), the title, then its project, when it was due (open tasks) and its stage pill;
// tracked time on the right.
function taskRow_(task, done, dueLabel) {
  var tracked = num_(task.trackedMinutes) > 0 ? esc_(fmtHM_(num_(task.trackedMinutes))) : '';
  var gap = '<span style="display:inline-block;width:12px"></span>';
  var meta = [];
  if (task.project) meta.push(chip_(task.color, 8, 7) + esc_(task.project));
  if (dueLabel) meta.push(esc_(dueLabel));
  var pill = stagePill_(task);
  if (pill) meta.push(pill);
  var rule = 'border-top:' + EM_RULE;
  return '<tr><td width="28" valign="top" style="padding:14px 0;' + rule + ';font-size:15px;line-height:1.5;' +
    (done ? 'font-weight:bold;color:' + EM_OK + '">&#10003;' : 'color:' + EM_FAINT + '">&#9675;') + '</td>' +
    '<td valign="top" style="padding:14px 12px 14px 0;' + rule + '"><div style="font-size:15px;line-height:1.5;font-weight:600">' + esc_(task.title) + '</div>' +
    (meta.length ? '<div style="font-size:13px;line-height:1.9;color:' + EM_MUTED + ';margin-top:2px">' + meta.join(gap) + '</div>' : '') + '</td>' +
    (tracked
      ? '<td valign="top" align="right" style="padding:14px 0;' + rule + ';font-size:14px;font-weight:bold;line-height:1.5;color:' + EM_INK + ';white-space:nowrap;' + EM_NUM + '">' +
        tracked + '<div style="font-size:12px;line-height:1.2;font-weight:normal;color:' + EM_MUTED + '">tracked</div></td>'
      : '<td valign="top" align="right" style="padding:14px 0;' + rule + '">&nbsp;</td>') + '</tr>';
}

function emptyNote_(text) {
  return '<div style="padding:14px 0;border-top:' + EM_RULE + ';font-size:15px;color:' + EM_MUTED + '">' + esc_(text) + '</div>';
}

// The standup in its card. colors: { 'k' + project name in lower case: '#hex' } for the project labels.
function standupPanel_(text, colors) {
  return '<div class="card" style="background:' + EM_TINT + ';border-radius:10px;padding:24px 24px">' + standupHtml_(text, colors) + '</div>';
}

// { 'k' + name in lower case: colour } from a project list.
function projectColors_(projects) {
  var out = {};
  for (var i = 0; i < (projects || []).length; i++) out['k' + String(projects[i].name).toLowerCase()] = projects[i].color;
  return out;
}

// The footer: a spacer, then the data line (green dot when the PC sent data that day), the footer text, the Sheet link.
function footerRow_(footer, sheetUrl, dataLine, dataOk, space) {
  return '<tr><td style="padding:' + (space || 36) + 'px ' + EM_PAD + ' 0"></td></tr>' +
    '<tr><td style="padding:22px ' + EM_PAD + ' 28px;border-top:' + EM_RULE + ';font-size:13px;line-height:1.7;color:' + EM_MUTED + '">' +
    (dataLine ? '<div style="margin-bottom:8px;color:' + EM_INK + '"><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:' +
      (dataOk ? EM_OK : EM_WARN) + ';margin-right:8px"></span>' + esc_(dataLine) + '</div>' : '') +
    esc_(footer) +
    (sheetUrl ? '<br><a href="' + esc_(sheetUrl) + '" style="display:inline-block;margin-top:10px;color:#0f3d2e;font-weight:bold">Open your WorkPulse Sheet &rarr;</a>' : '') +
    '</td></tr>';
}

// ---- Standup text (chat-style marks: *bold*, **bold**, _italic_, "- " or "• " bullets, bold-only lines as headings) ----

// One line of standup text as HTML: escaped first, then the marks become tags.
function standupInline_(s) {
  return esc_(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*\n]*?)\*/g, '<b>$1</b>')
    .replace(/(^|[^A-Za-z0-9_])_([^_\s][^_\n]*?)_(?![A-Za-z0-9_])/g, '$1<i>$2</i>');
}

// The standup read into its structure. The SAME rules as parseStandup in src/utils/standupDoc.ts (the app): a test runs
// both on the same samples. Returns [{ title, kind: 'done'|'doing'|'blocked'|'other', items: [ { kind: 'project', label,
// points: [{ text, subs }] } | { kind: 'point', point: { text, subs } } | { kind: 'line', text } ] }].
// Format: a bold-only line (or "# ...") is a heading; "- *project:* text" a point of that project; an indented "  - text"
// a sub-point of the point above. Points of the same project in a section are gathered, in the order each first appears.
function standupDoc_(text) {
  var sections = [];
  var cur = null;
  var last = null;
  var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  function section() {
    if (!cur) {
      cur = { title: '', kind: 'other', items: [] };
      sections.push(cur);
    }
    return cur;
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*$/.test(line)) continue;
    var bullet = /^(\s*)([-•]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    var trimmed = line.replace(/^\s+|\s+$/g, '');
    var h = /^#{1,3}\s+(.+)$/.exec(trimmed);
    var bold = /^\*{1,2}([^*\n]+?)\*{1,2}\s*$/.exec(line.replace(/^[^A-Za-z0-9*#ঀ-৿]+/, '').replace(/^\s+|\s+$/g, ''));
    if (h || (bold && !bullet)) {
      var title = (h ? h[1] : bold[1]).replace(/^\s+|\s+$/g, '');
      cur = { title: title, kind: sectionKind_(title), items: [] };
      sections.push(cur);
      last = null;
      continue;
    }
    var sec = section();
    if (bullet) {
      var content = bullet[3].replace(/^\s+|\s+$/g, '');
      if (bullet[1].replace(/\t/g, '  ').length >= 2 && last) {
        last.subs.push(content);
        continue;
      }
      var tag = /^\*{1,2}([^*\n]+?):\*{1,2}\s*(.*)$/.exec(content);
      var label = tag ? tag[1].replace(/^\s+|\s+$/g, '') : '';
      var point;
      if (tag && label) {
        point = { text: tag[2].replace(/^\s+|\s+$/g, ''), subs: [] };
        var group = null;
        for (var g = 0; g < sec.items.length; g++) {
          if (sec.items[g].kind === 'project' && sec.items[g].label.toLowerCase() === label.toLowerCase()) group = sec.items[g];
        }
        if (group) group.points.push(point);
        else sec.items.push({ kind: 'project', label: label, points: [point] });
      } else {
        point = { text: content, subs: [] };
        sec.items.push({ kind: 'point', point: point });
      }
      last = point;
      continue;
    }
    sec.items.push({ kind: 'line', text: trimmed });
    last = null;
  }
  return sections;
}

// What a heading announces: work done, work going on, or something stuck (sectionKind in standupDoc.ts).
function sectionKind_(title) {
  if (/block|waiting|stuck|risk/i.test(title)) return 'blocked';
  if (/progress|rolling|next|plan|tomorrow|ongoing/i.test(title)) return 'doing';
  if (/complet|done|finish|shipped/i.test(title)) return 'done';
  return 'other';
}

var SECTION_DOT = { done: EM_OK, doing: EM_WARN, blocked: EM_BAD, other: '#0f3d2e' };

function isNothing_(text) {
  return /^\s*(none|nothing|n\/a|-)\.?\s*$/i.test(String(text).replace(/\*/g, ''));
}

// One point: "•", its text (quieter when it only says "None"), and its sub-points under it with "–".
function standupPointHtml_(point) {
  var subs = '';
  for (var i = 0; i < point.subs.length; i++) {
    subs += '<tr><td valign="top" style="width:16px;font-size:14px;line-height:1.6;color:' + EM_MUTED + '">&ndash;</td>' +
      '<td style="font-size:14px;line-height:1.6;color:' + EM_MUTED + '">' + standupInline_(point.subs[i]) + '</td></tr>';
  }
  return '<tr><td valign="top" style="width:18px;padding:5px 0;font-size:15px;line-height:1.6;color:' + EM_FAINT + '">&bull;</td>' +
    '<td style="padding:5px 0;font-size:15px;line-height:1.6' + (isNothing_(point.text) ? ';color:' + EM_MUTED : '') + '">' + standupInline_(point.text) +
    (subs ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 2px">' + subs + '</table>' : '') + '</td></tr>';
}

function standupPoints_(points) {
  var rows = [];
  for (var p = 0; p < points.length; p++) rows.push(standupPointHtml_(points[p]));
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">' + rows.join('') + '</table>';
}

// The standup, read by standupDoc_: each section's title with a dot for its kind (the closing colon is not shown), each
// project as an uppercase label in its colour, its points with "•", sub-points with "–". A thin rule between sections.
// colors: from projectColors_.
function standupHtml_(text, colors) {
  colors = colors || {};
  var doc = standupDoc_(text);
  var h = [];
  for (var s = 0; s < doc.length; s++) {
    var sec = doc[s];
    h.push(s > 0 ? '<div style="border-top:1px solid #e3ddcd;margin-top:24px;padding-top:24px">' : '<div>');
    if (sec.title) {
      h.push('<div style="font-size:16px;line-height:1.4;font-weight:bold"><span style="display:inline-block;width:9px;height:9px;border-radius:5px;background:' +
        SECTION_DOT[sec.kind] + ';margin-right:10px;vertical-align:1px"></span>' + standupInline_(sec.title.replace(/\s*:\s*$/, '')) + '</div>');
    }
    for (var i = 0; i < sec.items.length; i++) {
      var it = sec.items[i];
      var top = sec.title || i > 0 ? '16px' : '0';
      if (it.kind === 'project') {
        var color = colors['k' + it.label.toLowerCase()];
        h.push('<div style="margin-top:' + top + ';font-size:12px;letter-spacing:.1em;text-transform:uppercase;font-weight:bold">' +
          (color ? chip_(color, 9, 8) : '') + esc_(it.label) + '</div>' + standupPoints_(it.points));
      } else if (it.kind === 'point') {
        h.push('<div style="margin-top:' + (sec.title || i > 0 ? '10px' : '0') + '">' + standupPoints_([it.point]) + '</div>');
      } else {
        h.push('<div style="margin-top:' + (sec.title || i > 0 ? '10px' : '0') + ';font-size:15px;line-height:1.6">' + standupInline_(it.text) + '</div>');
      }
    }
    h.push('</div>');
  }
  return h.join('');
}

// The standup for the plain-text body: the same structure, with the marks taken out.
function standupPlain_(text) {
  function bare(s) {
    return plain_(String(s).replace(/\*\*?([^*\n]+?)\*\*?/g, '$1'));
  }
  function point(p, t) {
    t.push('  - ' + bare(p.text));
    for (var i = 0; i < p.subs.length; i++) t.push('      - ' + bare(p.subs[i]));
  }
  var doc = standupDoc_(text);
  var t = [];
  for (var s = 0; s < doc.length; s++) {
    if (s > 0) t.push('');
    if (doc[s].title) t.push(bare(doc[s].title).toUpperCase());
    for (var i = 0; i < doc[s].items.length; i++) {
      var it = doc[s].items[i];
      if (it.kind === 'project') {
        t.push(plain_(it.label));
        for (var p = 0; p < it.points.length; p++) point(it.points[p], t);
      } else if (it.kind === 'point') point(it.point, t);
      else t.push(bare(it.text));
    }
  }
  return t.join('\n');
}

function emailHtml_(m) {
  var h = [];
  var preview;
  if (m.noData) {
    h.push(headerEmptyRow_(esc_(m.dayLong), 'No data yet', 'Nothing logged and no clock-in so far today.'));
    preview = 'No data yet today.';
  } else {
    var over = m.worked - m.target;
    // The clock line ("In 08:40 · Out 16:19", "In 09:10 · still clocked in", "not clocked in") as labelled cells.
    var parts = String(m.clockLine).split(' · ');
    var cells = [];
    var line = '';
    if (/^In /.test(parts[0])) {
      cells.push({ label: 'In', value: esc_(parts[0].slice(3)) });
      if (parts[1]) cells.push(/^Out /.test(parts[1]) ? { label: 'Out', value: esc_(parts[1].slice(4)) } : { label: 'Out', value: esc_(parts[1]), open: true });
    } else {
      line = esc_(m.clockLine);
    }
    h.push(headerRow_(esc_(m.dayLong), esc_(fmtHM_(m.worked)),
      over > 0 ? 'worked, ' + esc_(fmtHM_(over)) + ' over ' + esc_(fmtHM_(m.target)) : 'worked of ' + esc_(fmtHM_(m.target)),
      m.target > 0 ? (m.worked / m.target) * 100 : 0, cells, line));
    var logged = { value: esc_(fmtHM_(m.logMinutes)), label: m.logCount === 1 ? 'logged in 1 entry' : 'logged in ' + m.logCount + ' entries' };
    if (usesTasks_(m)) {
      h.push(statsRow_([
        logged,
        { value: String(m.done.length), label: m.done.length === 1 ? 'task done' : 'tasks done' },
        { value: String(m.openCount), label: 'still open' }
      ]));
      preview = fmtHM_(m.worked) + ' worked of ' + fmtHM_(m.target) + ', ' + m.done.length + ' done, ' + m.openCount + ' still open';
    } else {
      // A day run on logs alone (most of them automatic) counts what the logs did, not an empty task list (version 12).
      var things = thingsDone_(m.groups);
      var projects = m.groups.length;
      h.push(statsRow_([
        logged,
        { value: String(things), label: things === 1 ? 'thing done' : 'things done' },
        { value: String(projects), label: projects === 1 ? 'project' : 'projects' }
      ]));
      preview = fmtHM_(m.worked) + ' worked of ' + fmtHM_(m.target) + ', ' + things + (things === 1 ? ' thing' : ' things') + ' done, ' +
        projects + (projects === 1 ? ' project' : ' projects');
    }
  }

  var top = 34;
  if (m.standup) {
    h.push(sectionHead_('Standup', '', top, false));
    h.push(sectionBody_(standupPanel_(m.standup, m.projectColors)));
    top = 36;
  }

  // With a standup the logs are already summed up: only the time per project shows. Without one, a short line per log.
  if (m.groups.length) {
    h.push(sectionHead_(m.standup ? 'Time by project' : 'Logs', esc_(fmtHM_(m.logMinutes)), top, false));
    h.push(sectionBody_(splitBar_(m.groups) + (m.standup ? '' : compactLogs_(m.groups))));
    top = 36;
  } else if (!m.noData) {
    h.push(sectionHead_('Logs', '', top, true));
    h.push(sectionBody_(emptyNote_('No logs yet today.')));
    top = 36;
  }

  if (m.openCount) {
    var open = [];
    var shown = 0;
    for (var o = 0; o < m.openGroups.length && shown < EM_OPEN_MAX; o++) {
      for (var q = 0; q < m.openGroups[o].tasks.length && shown < EM_OPEN_MAX; q++) {
        open.push(taskRow_(m.openGroups[o].tasks[q], false, m.openGroups[o].label));
        shown++;
      }
    }
    var more = m.openCount - shown;
    h.push(sectionHead_('Still open', String(m.openCount), top, true));
    h.push(sectionBody_('<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + open.join('') + '</table>' +
      (more > 0 ? '<div style="padding:12px 0 0;border-top:' + EM_RULE + ';font-size:14px;color:' + EM_MUTED + '">and ' + more + ' more on your Plan</div>' : '')));
  }
  if (m.pendingLine) {
    h.push(sectionBody_('<div style="margin-top:16px;padding:12px 16px;background:#fdf0dc;border-radius:8px;font-size:14px;color:#7a3e0c">' + esc_(m.pendingLine) + '</div>'));
  }

  h.push(footerRow_(m.footer, m.sheetUrl, m.dataLine, m.dataOk, m.noData ? 32 : 36));
  return emailShell_(h.join(''), preview);
}

// The week standup: the week's hours with a bar per day, the standup, and time per project; the data line in the footer.
// w = { range, worked, target, perDay, days: [{ label, worked, open, off }], dayCount, openCount, dataLine, dataOk, standup,
// projectColors, groups, logMinutes, footer, sheetUrl }
function weekEmailHtml_(w) {
  var h = [];
  var over = w.worked - w.target;
  h.push(headerRow_('Week standup &middot; ' + esc_(w.range), esc_(fmtHM_(w.worked)),
    over > 0 ? 'worked, ' + esc_(fmtHM_(over)) + ' over ' + esc_(fmtHM_(w.target)) : 'worked of ' + esc_(fmtHM_(w.target)),
    w.target > 0 ? (w.worked / w.target) * 100 : 0, null,
    w.dayCount + (w.dayCount === 1 ? ' day at work' : ' days at work') + (w.openCount ? ', ' + w.openCount + ' without a clock-out' : '')));
  h.push(sectionHead_('Day by day', '', 34, false));
  var top = 1;
  for (var i = 0; i < w.days.length; i++) top = Math.max(top, w.days[i].worked, w.perDay);
  var rows = [];
  for (var d = 0; d < w.days.length; d++) {
    var day = w.days[d];
    rows.push('<tr><td width="72" style="padding:9px 0;font-size:14px;' + (day.off ? 'color:' + EM_FAINT : 'font-weight:600') + ';white-space:nowrap">' + esc_(day.label) + '</td>' +
      '<td style="padding:9px 14px">' + (day.off ? '<div style="height:1px;background:' + EM_LINE + '"></div>' : meter_((day.worked / top) * 100, day.open ? EM_WARN : '#0f3d2e', '#efebe1', 12, 0, 10)) + '</td>' +
      '<td width="56" align="right" style="padding:9px 0;font-size:14px;font-weight:bold;' + (day.off ? 'color:' + EM_FAINT : EM_NUM) + '">' +
      (day.off ? '&ndash;' : day.open ? 'open' : esc_(fmtHM_(day.worked))) + '</td></tr>');
  }
  h.push(sectionBody_('<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rows.join('') + '</table>'));

  if (w.standup) {
    h.push(sectionHead_('Standup', '', 36, false));
    h.push(sectionBody_(standupPanel_(w.standup, w.projectColors)));
  }
  if (w.groups.length) {
    h.push(sectionHead_('Time by project', esc_(fmtHM_(w.logMinutes)), 36, false));
    h.push(sectionBody_(splitBar_(w.groups)));
  }
  h.push(footerRow_(w.footer, w.sheetUrl, w.dataLine, w.dataOk, 36));
  return emailShell_(h.join(''), fmtHM_(w.worked) + ' worked over ' + w.dayCount + (w.dayCount === 1 ? ' day' : ' days'));
}

// ---- Plain text ----

function emailText_(m) {
  var t = [];
  t.push('WorkPulse \u00b7 ' + m.dayLong);
  if (m.noData) {
    t.push('No data yet. Nothing logged and no clock-in so far today.');
  } else {
    t.push(fmtHM_(m.worked) + ' worked of ' + fmtHM_(m.target));
    t.push(m.clockLine);
  }
  t.push(m.dataLine);
  t.push('');
  if (m.standup) {
    t.push('STANDUP');
    t.push(standupPlain_(m.standup));
    t.push('');
  }
  t.push('LOGS \u00b7 ' + m.logCount + ' \u00b7 ' + fmtHM_(m.logMinutes));
  if (m.groups.length === 0) t.push('No logs yet today.');
  for (var g = 0; g < m.groups.length; g++) {
    t.push(plain_(m.groups[g].name) + ' \u00b7 ' + fmtHM_(m.groups[g].minutes));
    for (var k = 0; k < m.groups[g].logs.length; k++) {
      t.push('  - ' + plain_(m.groups[g].logs[k].description) + ' (' + fmtHM_(num_(m.groups[g].logs[k].minutes)) + ')');
      var subs = m.groups[g].logs[k].subTasks || [];
      for (var su = 0; su < subs.length; su++) t.push('      - ' + plain_(subs[su]));
    }
  }
  if (usesTasks_(m)) {
    t.push('');
    t.push('STILL OPEN \u00b7 ' + m.openCount);
    if (m.openGroups.length === 0) t.push('Nothing open.');
  }
  for (var o = 0; o < m.openGroups.length; o++) {
    t.push(m.openGroups[o].label);
    for (var q = 0; q < m.openGroups[o].tasks.length; q++) {
      var task = m.openGroups[o].tasks[q];
      var note = stageNote_(task);
      t.push('  - ' + plain_(task.title) + (note ? ' (' + note + ')' : '') + taskMetaText_(task, false));
    }
  }
  if (m.pendingLine) t.push(m.pendingLine);
  t.push('');
  t.push(m.footer);
  if (m.sheetUrl) t.push('Your WorkPulse Sheet: ' + m.sheetUrl);
  return t.join('\n');
}
`;
