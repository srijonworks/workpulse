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
  if (hasKey && key !== '' && !/^[A-Za-z0-9_\-]{10,200}$/.test(key)) return badRequest_('That Gemini key does not look right.');
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
        tz: saved.tz, to: saved.to || '', geminiKey: !!props.getProperty('geminiKey')
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
  var subject = 'WorkPulse week standup \u00b7 ' + dayText_(target.from, 'd MMM') + ' to ' + dayText_(target.to, 'd MMM');
  // A week reads "this week", not "today" (the day email keeps "today").
  text = String(text).replace(/completed today/gi, 'completed this week');
  var footer = 'Sent by your WorkPulse script.';
  // The same top as the day email, summed over the week: worked of target, days and clock times, last data from the PC.
  var meta = getMeta_();
  var tz = userTz_(meta);
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var dayRows = readTab_('WorkPulse_Days');
  var worked = 0;
  var days = 0;
  var open = 0;
  for (var i = 0; i < dayRows.length; i++) {
    var dd = dateText_(dayRows[i][0], ssTz);
    if (dd < target.from || dd > target.to) continue;
    var cin = emailDate_(isoText_(dayRows[i][1]));
    var cout = emailDate_(isoText_(dayRows[i][2]));
    if (!cin) continue;
    days++;
    if (cout) worked += Math.max(0, Math.floor((cout.getTime() - cin.getTime()) / 60000));
    else open++;
  }
  var perDay = num_(meta.workdayHours) > 0 ? num_(meta.workdayHours) : DEFAULT_WORKDAY_HOURS;
  var pushed = emailDate_(meta.pushedAt);
  var range = dayText_(target.from, 'd MMM') + ' to ' + dayText_(target.to, 'd MMM');
  var daysLine = days === 0 ? 'no clocked days' : days + (days === 1 ? ' day' : ' days') + (open ? ' · ' + open + ' without a clock-out' : '');
  var dataLine = pushed
    ? 'The last data from your PC came on ' + Utilities.formatDate(pushed, tz, 'EEE d MMM') + ' at ' + clockTime_(pushed, tz) + '.'
    : 'No data from your PC yet.';
  var html = emailShell_(
    '<tr><td style="background:#0f3d2e;color:#f4f1e8;padding:18px 24px"><div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#afbbb0;font-weight:bold">Week standup · ' + esc_(range) + '</div>' +
      '<div style="font-size:38px;font-weight:bold;color:#f2b705;margin-top:6px;line-height:1">' + esc_(fmtHM_(worked)) +
      ' <span style="font-size:15px;color:#f4f1e8;font-weight:normal">worked of ' + esc_(fmtHM_(Math.round(perDay * 60 * days))) + '</span></div>' +
      '<div style="font-size:14px;margin-top:8px;color:#f4f1e8">' + esc_(daysLine) + '</div></td></tr>' +
      '<tr><td style="padding:6px 24px 0"><div style="font-size:12px;color:#5d6b63;padding:10px 0;border-bottom:1px solid #dcd8cb">' + esc_(dataLine) + '</div></td></tr>' +
      '<tr><td style="padding:16px 24px 4px"><div style="' + EM_LABEL + '">Standup</div></td></tr>' +
      '<tr><td style="padding:0 24px"><div style="border-top:2px solid #1d2b24;padding-top:10px;color:#1d2b24">' + standupHtml_(text) + '</div></td></tr>' +
      footerRow_(footer, sheetUrl));
  return { subject: subject, html: html, text: standupPlain_(text) + (sheetUrl ? '\n\nYour WorkPulse Sheet: ' + sheetUrl : '') };
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

// The logs of a date range from WorkPulse_Recent.
function rangeLogs_(from, to) {
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rows = readTab_('WorkPulse_Recent');
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var l = rows[i];
    if (l[0] === '') continue;
    var date = dateText_(l[1], ssTz);
    if (date < from || date > to) continue;
    out.push({ date: date, project: String(l[3] || '') || 'No project', description: String(l[5] || ''), status: String(l[6] || ''), minutes: num_(l[7]) });
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

function standupPrompt_(t, logs) {
  var lines = [];
  for (var i = 0; i < logs.length && i < 80; i++) {
    var l = logs[i];
    lines.push((i + 1) + '. [' + l.status.toUpperCase() + '] [Project: ' + l.project + '] ' + (t.kind === 'week' ? l.date + ' ' : '') +
      l.description.slice(0, 300) + (l.minutes ? ' (' + l.minutes + 'm)' : ''));
  }
  var when = t.kind === 'week' ? 'this week' : 'today';
  return 'Please generate a work report based on these logged tasks:\n\n--- LOGGED WORK ENTRIES ---\n' + lines.join('\n') +
    '\n---------------------------\n\nCovers: ' + (t.kind === 'week' ? 'the week ' + t.from + ' to ' + t.to : t.from) +
    '\n\nTarget Format: A clean, professional Slack/Teams standup update with exactly three sections. Use plain bold headings with no emoji. ' +
    'Under each heading write short bullets, one per piece of work, starting with the project name in bold (for example "- *project:* what was done"). ' +
    'No filler and no exclamation marks. The sections are:\n*What I completed ' + when + ':*\n*In progress / Rolling over:*\n*Blockers / Waiting on:*\n' +
    'Tone: casual\n\nGenerate the final message text now. Output it directly, with no code fence.';
}

// The standup in plain wording: the logs under the same three headings, one bullet each, project first.
function templateStandup_(t, logs) {
  function bullet(l) {
    return '- *' + l.project.replace(/[*:]/g, '') + ':* ' + l.description.replace(/\*/g, '').replace(/\s+/g, ' ');
  }
  var done = [];
  var going = [];
  var blocked = [];
  for (var i = 0; i < logs.length; i++) {
    if (logs[i].status === 'in_progress') going.push(bullet(logs[i]));
    else if (logs[i].status === 'blocked') blocked.push(bullet(logs[i]));
    else done.push(bullet(logs[i]));
  }
  return '*What I completed ' + (t.kind === 'week' ? 'this week' : 'today') + ':*\n' + (done.length ? done.join('\n') : '- Nothing marked done') +
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
    dayLong: dayLong, noData: noData, worked: worked, target: target, clockLine: clockLine, dataLine: dataLine,
    groups: groups, logCount: logs.length, logMinutes: logMinutes, done: done, openGroups: openGroups,
    openCount: open.length, pendingLine: pendingLine, footer: footer, standup: standup, sheetUrl: String(data.sheetUrl || '')
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

var EM_LABEL = 'font-size:13px;font-weight:bold;letter-spacing:.1em;text-transform:uppercase';

// The page, the card and its rows: rows is the HTML of the card's table rows.
function emailShell_(rows) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WorkPulse</title></head>' +
    '<body style="margin:0;background:#e7e3d6;padding:16px 8px;font-family:Arial,Helvetica,sans-serif;color:#1d2b24">' +
    // Fluid up to 620 px, so a phone shows it at full size instead of shrinking a fixed-width card.
    '<table role="presentation" width="100%" align="center" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;margin:0 auto;background:#fbfaf5;border:1px solid #dcd8cb">' +
    rows + '</table></body></html>';
}

var EM_RULE = '1px solid #e4e0d4';

// One list row like WorkPulse's History: an optional time column, the project's colour bar beside the content, and a
// figure on the right; a thin line under it. timeHtml null = no time column (task lists).
function listRow_(color, timeHtml, bodyHtml, rightHtml) {
  return '<tr>' +
    (timeHtml === null ? '' : '<td width="44" valign="top" style="padding:12px 10px 12px 0;font-size:12px;color:#5d6b63;white-space:nowrap;border-bottom:' + EM_RULE + '">' + timeHtml + '</td>') +
    '<td valign="top" style="padding:10px 12px;border-left:3px solid ' + safeColor_(color) + ';border-bottom:' + EM_RULE + '">' + bodyHtml + '</td>' +
    '<td width="56" valign="top" align="right" style="padding:10px 0 10px 8px;font-size:14px;font-weight:bold;color:#1d2b24;white-space:nowrap;border-bottom:' + EM_RULE + '">' + rightHtml + '</td>' +
    '</tr>';
}

// The second line of a row: short parts with space between them (no separators).
function rowMeta_(parts, gapBelow) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) out.push('<span style="margin-right:12px">' + parts[i] + '</span>');
  }
  return out.length ? '<div style="font-size:12px;line-height:1.4;color:#5d6b63;margin:3px 0 ' + (gapBelow ? '6px' : '0') + '">' + out.join('') + '</div>' : '';
}

// A task row: title, then project and stage; tracked time on the right.
function taskRow_(task, withProject) {
  var note = stageNote_(task);
  var tracked = num_(task.trackedMinutes) > 0 ? esc_(fmtHM_(num_(task.trackedMinutes))) : '';
  return listRow_(task.color, null,
    '<div style="font-size:14px;line-height:1.45;color:#1d2b24">' + esc_(task.title) + '</div>' +
      rowMeta_([withProject ? esc_(task.project || '') : '', note ? esc_(note) : ''], false),
    tracked ? tracked + '<div style="font-size:12px;font-weight:normal;color:#5d6b63">tracked</div>' : '');
}

function footerRow_(footer, sheetUrl) {
  return '<tr><td style="padding:22px 24px 20px;font-size:12px;color:#5d6b63;border-top:1px solid #dcd8cb">' + esc_(footer) +
    (sheetUrl ? ' <a href="' + esc_(sheetUrl) + '" style="color:#0f3d2e">Open your WorkPulse Sheet</a>' : '') + '</td></tr>';
}

// ---- Standup text (chat-style marks: *bold*, **bold**, _italic_, "- " or "• " bullets, bold-only lines as headings) ----

// One line of standup text as HTML: escaped first, then the marks become tags.
function standupInline_(s) {
  return esc_(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\s][^*\n]*?)\*/g, '<b>$1</b>')
    .replace(/(^|[^A-Za-z0-9_])_([^_\s][^_\n]*?)_(?![A-Za-z0-9_])/g, '$1<i>$2</i>');
}

// The lines as blocks: { k: 'h', text } heading, { k: 'g', label, items } one project's bullets, { k: 'b', text } bullet,
// { k: 'l', text } line, { k: 'gap' }. Inside a section, bullets that start with "*project:*" are gathered into one group per
// project, in the order each first appears, where the first of them was.
function standupBlocks_(text) {
  var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  var out = [];
  var groups = null;
  var at = 0;
  function close() {
    if (!groups) return;
    var made = [];
    for (var g = 0; g < groups.order.length; g++) made.push(groups.map['k' + groups.order[g]]);
    out.splice.apply(out, [at, 0].concat(made));
    groups = null;
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*$/.test(line)) {
      if (!groups) out.push({ k: 'gap' });
      continue;
    }
    var hm = /^#{1,3}\s+(.+)$/.exec(line);
    // A line that is only a bold phrase, maybe after an emoji or symbol, is a heading; the symbol is dropped.
    var bold = /^\*{1,2}([^*\n]+?)\*{1,2}\s*$/.exec(line.replace(/^[\s -⯿\ud800-\udfff️‍]+/, ''));
    var bm = /^\s*([-•]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    if (hm || (bold && !bm)) {
      close();
      out.push({ k: 'h', text: hm ? hm[1] : bold[1] });
      continue;
    }
    if (bm) {
      var tag = /^\*{1,2}([^*\n]+?):\*{1,2}\s*(.*)$/.exec(bm[2]);
      if (tag && tag[1].replace(/\s+/g, '') !== '') {
        if (!groups) {
          groups = { order: [], map: {} };
          at = out.length;
        }
        var key = tag[1].replace(/^\s+|\s+$/g, '').toLowerCase();
        if (!groups.map.hasOwnProperty('k' + key)) {
          groups.order.push(key);
          groups.map['k' + key] = { k: 'g', label: tag[1].replace(/^\s+|\s+$/g, ''), items: [] };
        }
        groups.map['k' + key].items.push(tag[2]);
        continue;
      }
      out.push({ k: 'b', text: bm[2] });
      continue;
    }
    out.push({ k: 'l', text: line });
  }
  close();
  return out;
}

function bulletRow_(inlineHtml) {
  return '<tr><td valign="top" style="width:16px;padding:2px 0;font-size:14px;color:#5d6b63">&bull;</td>' +
    '<td style="padding:2px 0;font-size:14px;line-height:1.5">' + inlineHtml + '</td></tr>';
}

function standupHtml_(text) {
  var blocks = standupBlocks_(text);
  var h = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var first = h.length === 0;
    if (b.k === 'gap') {
      if (!first) h.push('<div style="height:6px"></div>');
    } else if (b.k === 'h') {
      h.push('<div style="font-size:15px;font-weight:bold;margin:' + (first ? '0' : '12px') + ' 0 4px">' + standupInline_(b.text) + '</div>');
    } else if (b.k === 'g') {
      h.push('<div style="font-size:14px;font-weight:bold;color:#0f3d2e;margin:' + (first ? '0' : '8px') + ' 0 2px 4px">' + esc_(b.label) + '</div>');
      var rows = [];
      for (var j = 0; j < b.items.length; j++) rows.push(bulletRow_(standupInline_(b.items[j])));
      h.push('<table role="presentation" cellpadding="0" cellspacing="0" style="margin-left:14px">' + rows.join('') + '</table>');
    } else if (b.k === 'b') {
      h.push('<table role="presentation" cellpadding="0" cellspacing="0" style="margin-left:4px">' + bulletRow_(standupInline_(b.text)) + '</table>');
    } else {
      h.push('<div style="font-size:14px;line-height:1.5">' + standupInline_(b.text) + '</div>');
    }
  }
  return h.join('');
}

// The standup for the plain-text body: the same grouping, with the marks taken out.
function standupPlain_(text) {
  function bare(s) {
    return plain_(String(s).replace(/\*\*?([^*\n]+?)\*\*?/g, '$1'));
  }
  var blocks = standupBlocks_(text);
  var t = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.k === 'gap') t.push('');
    else if (b.k === 'h') t.push(bare(b.text).toUpperCase());
    else if (b.k === 'g') {
      t.push(plain_(b.label));
      for (var j = 0; j < b.items.length; j++) t.push('  - ' + bare(b.items[j]));
    } else if (b.k === 'b') t.push('  - ' + bare(b.text));
    else t.push(bare(b.text));
  }
  return t.join('\n');
}

function emailHtml_(m) {
  var h = [];
  h.push('<tr><td style="background:#0f3d2e;color:#f4f1e8;padding:18px 24px">');
  h.push('<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#afbbb0;font-weight:bold">' + esc_(m.dayLong) + '</div>');
  if (m.noData) {
    h.push('<div style="font-size:30px;font-weight:bold;color:#f2b705;margin-top:6px;line-height:1">No data yet</div>');
    h.push('<div style="font-size:14px;margin-top:8px;color:#f4f1e8">Nothing logged and no clock-in so far today.</div>');
  } else {
    h.push('<div style="font-size:38px;font-weight:bold;color:#f2b705;margin-top:6px;line-height:1">' + esc_(fmtHM_(m.worked)) +
      ' <span style="font-size:15px;color:#f4f1e8;font-weight:normal">worked of ' + esc_(fmtHM_(m.target)) + '</span></div>');
    h.push('<div style="font-size:14px;margin-top:8px;color:#f4f1e8">' + esc_(m.clockLine).replace(/ \u00b7 /g, ' &nbsp;&middot;&nbsp; ') + '</div>');
  }
  h.push('</td></tr>');

  h.push('<tr><td style="padding:6px 24px 0"><div style="font-size:12px;color:#5d6b63;padding:10px 0;border-bottom:1px solid #dcd8cb">' + esc_(m.dataLine) + '</div></td></tr>');

  if (m.standup) {
    h.push('<tr><td style="padding:16px 24px 4px"><div style="' + EM_LABEL + '">Standup</div></td></tr>');
    h.push('<tr><td style="padding:0 24px"><div style="border-top:2px solid #1d2b24;padding-top:10px;color:#1d2b24">' + standupHtml_(m.standup) + '</div></td></tr>');
  }

  h.push('<tr><td style="padding:' + (m.standup ? '24px' : '16px') + ' 24px 4px"><div style="' + EM_LABEL + '">Logs &middot; ' + m.logCount + ' &middot; ' + esc_(fmtHM_(m.logMinutes)) + '</div></td></tr>');
  // Logs as in WorkPulse's History: one row each, by time, with the time, the project's colour bar, the text, the
  // project under it, the sub-tasks, and the minutes on the right; a thin line between rows.
  h.push('<tr><td style="padding:0 24px">');
  var flat = [];
  for (var g = 0; g < m.groups.length; g++) {
    for (var k = 0; k < m.groups[g].logs.length; k++) flat.push({ log: m.groups[g].logs[k], name: m.groups[g].name, color: m.groups[g].color });
  }
  flat.sort(function (a, b) {
    var x = String(a.log.time || '');
    var y = String(b.log.time || '');
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (flat.length === 0) {
    h.push('<div style="border-top:2px solid #1d2b24;padding-top:8px;font-size:14px;color:#5d6b63">No logs yet today.</div>');
  } else {
    // Time per project, biggest first, before the rows.
    var totals = [];
    for (var t = 0; t < m.groups.length; t++) {
      totals.push('<span style="display:inline-block;margin:0 16px 4px 0;white-space:nowrap"><span style="display:inline-block;width:8px;height:8px;background:' +
        safeColor_(m.groups[t].color) + ';margin-right:6px"></span>' + esc_(m.groups[t].name) + ' <span style="font-weight:bold">' + esc_(fmtHM_(m.groups[t].minutes)) + '</span></span>');
    }
    h.push('<div style="font-size:13px;color:#1d2b24;padding:2px 0 6px">' + totals.join('') + '</div>');
    h.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #1d2b24">');
    for (var f = 0; f < flat.length; f++) {
      var lg = flat[f].log;
      var subs = lg.subTasks || [];
      var subHtml = '';
      for (var su = 0; su < subs.length; su++) {
        subHtml += '<div style="font-size:13px;line-height:1.5;color:#5d6b63;padding-left:12px">&ndash; ' + esc_(subs[su]) + '</div>';
      }
      h.push(listRow_(flat[f].color, esc_(lg.time || ''),
        '<div style="font-size:14px;line-height:1.45;color:#1d2b24">' + esc_(lg.description) + '</div>' +
          rowMeta_([esc_(flat[f].name), subs.length ? subs.length + (subs.length === 1 ? ' sub-task' : ' sub-tasks') : ''], subs.length > 0) + subHtml,
        esc_(fmtHM_(num_(lg.minutes)))));
    }
    h.push('</table>');
  }
  h.push('</td></tr>');

  h.push('<tr><td style="padding:22px 24px 4px"><div style="' + EM_LABEL + '">Tasks done today &middot; ' + m.done.length + '</div>');
  if (m.done.length === 0) {
    h.push('<div style="border-top:2px solid #1d2b24;margin-top:6px;font-size:14px;padding-top:8px;color:#5d6b63">None yet.</div>');
  } else {
    h.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #1d2b24;margin-top:6px">');
    for (var d = 0; d < m.done.length; d++) h.push(taskRow_(m.done[d], true));
    h.push('</table>');
  }
  h.push('</td></tr>');

  h.push('<tr><td style="padding:18px 24px 4px"><div style="' + EM_LABEL + '">Still open &middot; ' + m.openCount + '</div>');
  if (m.openGroups.length === 0) {
    h.push('<div style="border-top:2px solid #1d2b24;margin-top:6px;padding-top:8px;font-size:14px;color:#5d6b63">Nothing open.</div>');
  } else {
    h.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #1d2b24;margin-top:6px">');
    for (var o = 0; o < m.openGroups.length; o++) {
      h.push('<tr><td colspan="2" style="padding:14px 0 4px;font-size:13px;font-weight:bold;color:#1d2b24;border-bottom:' + EM_RULE + '">' + esc_(m.openGroups[o].label) + '</td></tr>');
      for (var q = 0; q < m.openGroups[o].tasks.length; q++) h.push(taskRow_(m.openGroups[o].tasks[q], true));
    }
    h.push('</table>');
  }
  if (m.pendingLine) {
    h.push('<div style="font-size:13px;color:#7a5a00;margin-top:8px;font-weight:bold">' + esc_(m.pendingLine) + '</div>');
  }
  h.push('</td></tr>');

  h.push(footerRow_(m.footer, m.sheetUrl));
  return emailShell_(h.join(''));
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
  t.push('');
  t.push('TASKS DONE TODAY \u00b7 ' + m.done.length);
  if (m.done.length === 0) t.push('None yet.');
  for (var d = 0; d < m.done.length; d++) t.push('  - ' + plain_(m.done[d].title) + taskMetaText_(m.done[d], true));
  t.push('');
  t.push('STILL OPEN \u00b7 ' + m.openCount);
  if (m.openGroups.length === 0) t.push('Nothing open.');
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
