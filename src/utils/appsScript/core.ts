// Version 6 of the WorkPulse Apps Script (3 added the phone page, 4 the full backup in backup.ts, 5 the email recipients and sub-tasks,
// 6 the locked log writes, day history, standup emails and phoneAddLog): phone PIN, desktop token, state tabs and the phone inbox.
// Plain ES5-style Apps Script text, appended after the log code in googleAppsScriptTemplate.ts.
//
// google.script.run can call every top-level function whose name does not end with "_", from an
// anonymous page. So every helper ends with "_"; the only callable names are the web app entry points,
// the PIN-checked phone functions and the brief's checkPin/checkToken/hashSecret/withLock, which change
// nothing without a secret (checkPin counts a wrong PIN like any other PIN check).
export const SCRIPT_CORE = String.raw`
// =========================================================================
// Phone page, phone inbox and desktop state (version 3 and later)
// =========================================================================

var SCRIPT_VERSION = 7;
var MAX_PIN_TRIES = 5;
var LOCK_MINUTES = 15;
var MAX_TITLE = 200;
var MAX_PENDING = 500;
var MAX_CELL = 5000;
var STANDUP_MAX = 20000;
var OLDER_LOG_DAYS = 14;
var DEFAULT_WORKDAY_HOURS = 8;

var TAB_COLUMNS = {
  WorkPulse_Tasks: ['Id', 'Title', 'Project', 'ProjectId', 'DueDate', 'Stage', 'TrackedMinutes', 'CompletedAt', 'FromPhone'],
  WorkPulse_Days: ['Date', 'ClockIn', 'ClockOut'],
  WorkPulse_Recent: ['Id', 'Date', 'Time', 'Project', 'ProjectId', 'Description', 'Status', 'Minutes', 'SubTasks', 'Origin'],
  WorkPulse_Inbox: ['Id', 'CreatedAt', 'Title', 'ProjectId', 'ProjectName', 'DueDate', 'Status'],
  WorkPulse_Projects: ['Id', 'Name', 'Color'],
  WorkPulse_Backup: ['Version', 'Chunk', 'Total', 'Data', 'SavedAt', 'Counts'],
  WorkPulse_DayHistory: ['Date', 'ClockIn', 'ClockOut', 'WorkedMinutes', 'LoggedMinutes', 'LogCount', 'ClosedAt'],
  WorkPulse_Standups: ['Id', 'Kind', 'From', 'To', 'Text', 'Writer', 'CreatedAt', 'EditedAt']
};

var MESSAGES = {
  no_pin: 'No phone PIN is set yet. Set one in WorkPulse Settings on your PC.',
  bad_pin: 'That PIN is not right.',
  bad_token: 'This computer is not linked to the phone page any more. Use Reset phone access in Settings (it asks for your current PIN).',
  bad_request: 'The Sheet script did not understand the request.',
  busy: 'The Sheet is busy with another update. Nothing was changed. WorkPulse will try again.'
};

// ---- Web app entry points ----

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.page === 'phone') {
      return servePhonePage();
    }
    var action = params.action || 'ping';
    if (action === 'ping') {
      return pingOutput_();
    }
    return jsonOut_({ status: 'ok', message: 'Unknown action' });
  } catch (error) {
    return jsonOut_({ status: 'error', message: error.toString() });
  }
}

function doPost(e) {
  try {
    var contents = {};
    if (e.postData && e.postData.contents) {
      try {
        contents = JSON.parse(e.postData.contents);
      } catch (err) {}
    }
    if (!contents || typeof contents !== 'object') contents = {};
    var action = contents.action || (e.parameter && e.parameter.action) || 'ping';

    if (action === 'ping') {
      return pingOutput_();
    }
    var core = handleCoreAction_(action, contents);
    if (core) {
      return jsonOut_(core);
    }
    return handleLogAction_(action, contents);
  } catch (error) {
    return jsonOut_(scriptError_(error));
  }
}

// servePhonePage() lives in SCRIPT_PHONE (phonePage.ts), appended after this code.

function pingOutput_() {
  return jsonOut_({
    status: 'ok',
    message: 'WorkPulse Google Sheets Sync is active and connected!',
    version: SCRIPT_VERSION,
    timestamp: new Date().toISOString()
  });
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// The answer for a desktop action, or null when the action is not one of these (the log code handles it).
function handleCoreAction_(action, c) {
  if (action === 'setPin') return setPinAction_(c);
  if (action === 'resetAccess') return resetAccessAction_(c);
  if (action === 'pushState') return pushStateAction_(c);
  if (action === 'pullInbox') return pullInboxAction_(c);
  if (action === 'ackInbox') return ackInboxAction_(c);
  if (action === 'setEmail') return setEmailAction_(c);
  if (action === 'sendTestEmail') return sendTestEmailAction_(c);
  if (action === 'saveBackup') return saveBackupAction_(c);
  if (action === 'backupInfo') return backupInfoAction_(c);
  if (action === 'loadBackup') return loadBackupAction_(c);
  if (action === 'saveHistory') return saveHistoryAction_(c);
  if (action === 'sendDayEmail') return sendDayEmailAction_(c);
  if (action === 'emailStatus') return emailStatusAction_(c);
  if (action === 'cancelDayEmail') return cancelDayEmailAction_(c);
  return null;
}

// ---- Secrets, lock and the wrong-PIN counter ----

function hashSecret(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// Runs fn while holding the script lock. Nested calls in the same execution reuse the held lock.
var LOCK_DEPTH = 0;
function withLock(fn) {
  if (LOCK_DEPTH > 0) return fn();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_DEPTH++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH--;
    lock.releaseLock();
  }
}

// Like withLock, but gives up after 20 s without throwing: { got: false } when another execution holds the
// lock (nothing has run), else { got: true, value }. Nested calls in the same execution reuse the held lock.
function tryLocked_(fn) {
  if (LOCK_DEPTH > 0) return { got: true, value: fn() };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { got: false };
  LOCK_DEPTH++;
  try {
    return { got: true, value: fn() };
  } finally {
    LOCK_DEPTH--;
    lock.releaseLock();
  }
}

// The desktop answer when the lock stayed taken: nothing was written, the same request can be sent again.
function busyAnswer_() {
  return { status: 'error', code: 'busy', message: MESSAGES.busy, detail: 'The script lock was not free within 20 seconds.' };
}

// An unexpected error as a plain sentence for the person, with the technical text kept in detail.
function scriptError_(error) {
  return {
    status: 'error',
    code: 'error',
    message: 'The Sheet script could not finish that. Nothing more was changed. Try again in a minute.',
    detail: String(error && error.toString ? error.toString() : error).slice(0, 300)
  };
}

function fail_(code, message, extra) {
  var r = { ok: false, code: code, message: message || MESSAGES[code] || MESSAGES.bad_request };
  if (extra) {
    for (var k in extra) r[k] = extra[k];
  }
  return r;
}

function lockedResult_(lockUntil, now) {
  var minutes = Math.max(1, Math.ceil((lockUntil - now) / 60000));
  return fail_('locked', 'Too many wrong PINs. Try again in ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.'), {
    lockedUntil: new Date(lockUntil).toISOString()
  });
}

// The phone PIN check. Only this counts wrong attempts: after MAX_PIN_TRIES wrong PINs every PIN check
// is refused for LOCK_MINUTES. The count is reset only by a right PIN (or a new PIN), so after a lock
// ends each further wrong PIN starts a new lock.
function checkPin(pin) {
  return withLock(function () {
    var props = PropertiesService.getScriptProperties();
    var pinHash = props.getProperty('pinHash');
    if (!pinHash) return fail_('no_pin');
    var now = new Date().getTime();
    var lockUntil = Number(props.getProperty('lockUntil') || 0);
    if (now < lockUntil) return lockedResult_(lockUntil, now);
    if (typeof pin === 'string' && pin !== '' && hashSecret(pin) === pinHash) {
      clearFailures_(props);
      return { ok: true };
    }
    var count = Number(props.getProperty('failCount') || 0) + 1;
    props.setProperty('failCount', String(count));
    if (count >= MAX_PIN_TRIES) {
      lockUntil = now + LOCK_MINUTES * 60000;
      props.setProperty('lockUntil', String(lockUntil));
      return lockedResult_(lockUntil, now);
    }
    return fail_('bad_pin', null, { triesLeft: MAX_PIN_TRIES - count });
  });
}

// The desktop token check. It never touches the wrong-PIN counter and works while PIN checks are locked.
function checkToken(token) {
  var tokenHash = PropertiesService.getScriptProperties().getProperty('tokenHash');
  if (!tokenHash || typeof token !== 'string' || token === '' || hashSecret(token) !== tokenHash) {
    return fail_('bad_token');
  }
  return { ok: true };
}

function clearFailures_(props) {
  props.deleteProperty('failCount');
  props.deleteProperty('lockUntil');
}

function validPin_(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

// Stores a new PIN and a new desktop token (the old token stops working) and clears any lock.
function savePinAndToken_(pin) {
  var props = PropertiesService.getScriptProperties();
  var token = newToken_();
  props.setProperty('pinHash', hashSecret(pin));
  props.setProperty('tokenHash', hashSecret(token));
  clearFailures_(props);
  return token;
}

// A failed check as a desktop answer.
function errorOf_(check) {
  var r = { status: 'error', code: check.code, message: check.message };
  if (check.lockedUntil) r.lockedUntil = check.lockedUntil;
  return r;
}

function badRequest_(message) {
  return { status: 'error', code: 'bad_request', message: message || MESSAGES.bad_request };
}

// ---- Desktop actions ----

// { pin, token?, oldPin? }. The first PIN needs no secret (the secret link is the first factor);
// changing it needs the desktop token or the old PIN.
function setPinAction_(c) {
  if (!validPin_(c.pin)) return badRequest_('The PIN must be 4 digits.');
  return withLock(function () {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('pinHash')) {
      var allowed = c.token ? checkToken(c.token) : fail_('bad_token');
      if (!allowed.ok && c.oldPin) allowed = checkPin(String(c.oldPin));
      if (!allowed.ok) return errorOf_(allowed);
    }
    return { status: 'ok', token: savePinAndToken_(c.pin) };
  });
}

// { pin, newPin }: a new desktop token for a computer that lost it, with the current PIN.
function resetAccessAction_(c) {
  if (!validPin_(c.newPin)) return badRequest_('The new PIN must be 4 digits.');
  return withLock(function () {
    var check = checkPin(c.pin);
    if (!check.ok) return errorOf_(check);
    return { status: 'ok', token: savePinAndToken_(c.newPin) };
  });
}

// { token, tasks, logs, workdays, projects, workdayHours, tz, deviceId, today }: replaces the state tabs.
function pushStateAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  if (!isArray_(c.tasks) || !isArray_(c.logs) || !isArray_(c.projects) || !isObject_(c.workdays) || !isDateText_(c.today)) {
    return badRequest_('The data from your PC was not complete. Update WorkPulse and try again.');
  }
  return withLock(function () {
    var i;
    var tasks = [];
    for (i = 0; i < c.tasks.length; i++) {
      var t = c.tasks[i] || {};
      tasks.push([
        str_(t.id), str_(t.title), str_(t.project), str_(t.projectId), str_(t.dueDate), str_(t.stage),
        num_(t.trackedMinutes), str_(t.completedAt), t.fromPhone === true ? 'TRUE' : 'FALSE'
      ]);
    }
    var days = [];
    for (var date in c.workdays) {
      if (!Object.prototype.hasOwnProperty.call(c.workdays, date)) continue;
      var w = c.workdays[date] || {};
      days.push([str_(date), str_(w.clockIn), str_(w.clockOut)]);
    }
    var logs = [];
    for (i = 0; i < c.logs.length; i++) {
      var l = c.logs[i] || {};
      logs.push([
        str_(l.id), str_(l.date), str_(l.time), str_(l.project), str_(l.projectId), str_(l.description),
        str_(l.status), num_(l.minutes), subTasksText_(l.subTasks), l.origin === 'auto' ? 'auto' : ''
      ]);
    }
    var projects = [];
    for (i = 0; i < c.projects.length; i++) {
      var p = c.projects[i] || {};
      projects.push([str_(p.id), str_(p.name), str_(p.color)]);
    }

    replaceRows_('WorkPulse_Tasks', tasks);
    replaceRows_('WorkPulse_Days', days);
    replaceRows_('WorkPulse_Recent', logs);
    replaceRows_('WorkPulse_Projects', projects);

    var props = PropertiesService.getScriptProperties();
    var old = getMeta_();
    var deviceId = str_(c.deviceId).slice(0, 100);
    var hours = Number(c.workdayHours);
    var meta = {
      pushedAt: new Date().toISOString(),
      tz: str_(c.tz).slice(0, 100),
      deviceId: deviceId,
      workdayHours: hours > 0 && hours <= 24 ? hours : DEFAULT_WORKDAY_HOURS,
      today: c.today,
      deviceChanged: !!(old.deviceId && deviceId && old.deviceId !== deviceId)
    };
    props.setProperty('meta', JSON.stringify(meta));
    return { status: 'ok', pushedAt: meta.pushedAt, deviceChanged: meta.deviceChanged };
  });
}

// { token }: the phone tasks the desktop has not taken yet.
function pullInboxAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  return { status: 'ok', items: pendingItems_() };
}

// { token, ids }: marks those inbox items taken. Unknown ids are ignored.
function ackInboxAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  if (!isArray_(c.ids)) return badRequest_();
  var wanted = {};
  for (var i = 0; i < c.ids.length; i++) wanted[String(c.ids[i])] = true;
  return withLock(function () {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('WorkPulse_Inbox');
    if (!sheet) return { status: 'ok', taken: 0 };
    var rows = dataRows_(sheet, TAB_COLUMNS.WorkPulse_Inbox.length);
    if (rows.length === 0) return { status: 'ok', taken: 0 };
    var status = [];
    var taken = 0;
    for (var r = 0; r < rows.length; r++) {
      var s = String(rows[r][6]);
      if (s === 'pending' && wanted[String(rows[r][0])] === true) {
        s = 'taken';
        taken++;
      }
      status.push([s]);
    }
    if (taken > 0) {
      sheet.getRange(2, 7, status.length, 1).setNumberFormat('@').setValues(status);
    }
    return { status: 'ok', taken: taken };
  });
}

// { token, days: [{ date, clockIn, clockOut, workedMinutes, loggedMinutes, logCount, closedAt }], standups: [{ id, kind, from, to,
// text, writer, createdAt, editedAt }] }: adds or updates rows (a day by its date, a standup by its id). Nothing is deleted.
function saveHistoryAction_(c) {
  var check = checkToken(c.token);
  if (!check.ok) return errorOf_(check);
  var days = c.days == null ? [] : c.days;
  var standups = c.standups == null ? [] : c.standups;
  if (!isArray_(days) || !isArray_(standups) || days.length > 400 || standups.length > 200) {
    return badRequest_('The history from your PC was not complete. Update WorkPulse and try again.');
  }
  var dayRows = [];
  var standupRows = [];
  var i;
  for (i = 0; i < days.length; i++) {
    var d = days[i] || {};
    if (!isDateText_(d.date)) return badRequest_('A day in the history had no valid date.');
    dayRows.push([d.date, str_(d.clockIn), str_(d.clockOut), num_(d.workedMinutes), num_(d.loggedMinutes), num_(d.logCount), str_(d.closedAt)]);
  }
  for (i = 0; i < standups.length; i++) {
    var u = standups[i] || {};
    if (!str_(u.id) || (u.kind !== 'day' && u.kind !== 'week') || !isDateText_(u.from) || !isDateText_(u.to)) {
      return badRequest_('A standup in the history was not complete.');
    }
    standupRows.push([str_(u.id), u.kind, u.from, u.to, String(u.text == null ? '' : u.text).slice(0, STANDUP_MAX), str_(u.writer), str_(u.createdAt), str_(u.editedAt)]);
  }
  var res = tryLocked_(function () {
    upsertByKey_('WorkPulse_DayHistory', dayRows);
    upsertByKey_('WorkPulse_Standups', standupRows);
    return { status: 'ok', days: dayRows.length, standups: standupRows.length };
  });
  return res.got ? res.value : busyAnswer_();
}

// Rows into a tab by the text of their first column: a known key is updated in place, a new one is added.
function upsertByKey_(name, rows) {
  if (rows.length === 0) return;
  var sheet = getTab_(name);
  var width = TAB_COLUMNS[name].length;
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var index = {};
  var existing = dataRows_(sheet, width);
  for (var i = 0; i < existing.length; i++) {
    var key = dateText_(existing[i][0], ssTz);
    if (key !== '') index[key] = i + 2;
  }
  var fresh = [];
  var freshAt = {};
  for (var r = 0; r < rows.length; r++) {
    var at = index[rows[r][0]];
    if (at) {
      sheet.getRange(at, 1, 1, width).setNumberFormat('@').setValues([rows[r]]);
    } else if (freshAt[rows[r][0]] !== undefined) {
      fresh[freshAt[rows[r][0]]] = rows[r];
    } else {
      freshAt[rows[r][0]] = fresh.length;
      fresh.push(rows[r]);
    }
  }
  if (fresh.length > 0) writeRows_(sheet, sheet.getLastRow() + 1, fresh);
}

// ---- Phone page functions (google.script.run) ----

// Errors that are not about the PIN or the request become one plain sentence for the phone.
function phoneCall_(fn) {
  try {
    return fn();
  } catch (error) {
    console.error(error);
    return fail_('error', 'The Sheet could not answer just now. Try again in a minute.');
  }
}

// Read under the lock too, so a phone read never sees a tab half way through a push.
function phoneData(pin) {
  return phoneCall_(function () {
    return withLock(function () {
      return phoneDataLocked_(pin);
    });
  });
}

function phoneDataLocked_(pin) {
  var check = checkPin(pin);
  if (!check.ok) return check;
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var meta = getMeta_();
  var i;

  var tasks = [];
  var taskRows = readTab_('WorkPulse_Tasks');
  for (i = 0; i < taskRows.length; i++) {
    var t = taskRows[i];
    if (String(t[5]) === 'done' || t[0] === '') continue;
    tasks.push({
      id: String(t[0]), title: String(t[1]), project: String(t[2]), projectId: String(t[3]),
      dueDate: dateText_(t[4], ssTz), stage: String(t[5]), trackedMinutes: num_(t[6]),
      completedAt: isoText_(t[7]), fromPhone: t[8] === true || String(t[8]).toUpperCase() === 'TRUE'
    });
  }

  var logs = [];
  var logRows = readTab_('WorkPulse_Recent');
  for (i = 0; i < logRows.length; i++) {
    var l = logRows[i];
    if (l[0] === '') continue;
    logs.push({
      id: String(l[0]), date: dateText_(l[1], ssTz), time: timeText_(l[2], ssTz), project: String(l[3]),
      projectId: String(l[4]), description: String(l[5]), status: String(l[6]), minutes: num_(l[7])
    });
  }

  var workdays = {};
  var dayRows = readTab_('WorkPulse_Days');
  for (i = 0; i < dayRows.length; i++) {
    var d = dateText_(dayRows[i][0], ssTz);
    if (d) workdays[d] = { clockIn: isoText_(dayRows[i][1]), clockOut: isoText_(dayRows[i][2]) };
  }

  return {
    ok: true,
    tasks: tasks,
    logs: logs,
    workdays: workdays,
    projects: projectList_(),
    pushedAt: meta.pushedAt || '',
    today: todayIn_(userTz_(meta)),
    workdayHours: meta.workdayHours || DEFAULT_WORKDAY_HOURS,
    pending: pendingItems_()
  };
}

// task = { title, projectId, day: 'today' | 'tomorrow' }. The date is the user's own (the zone the PC
// last sent), not the phone's or the Sheet's.
function phoneAddTask(pin, task) {
  return phoneCall_(function () {
    return withLock(function () {
      var check = checkPin(pin);
      if (!check.ok) return check;
      task = task && typeof task === 'object' ? task : {};
      var title = String(task.title == null ? '' : task.title).trim().slice(0, MAX_TITLE);
      if (!title) return fail_('bad_request', 'Type a task first.');
      if (task.day !== 'today' && task.day !== 'tomorrow') return fail_('bad_request', 'Pick Today or Tomorrow.');
      if (pendingItems_().length >= MAX_PENDING) {
        return fail_('bad_request', 'The phone inbox is full. Open WorkPulse on your PC to take the waiting tasks.');
      }
      var projectId = str_(task.projectId).slice(0, 200);
      var projectName = '';
      var projects = projectList_();
      for (var i = 0; i < projects.length; i++) {
        if (projects[i].id === projectId) projectName = projects[i].name;
      }
      var today = todayIn_(userTz_(getMeta_()));
      var now = new Date();
      var item = {
        id: 'phone-' + now.getTime() + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8),
        title: title,
        projectId: projectId,
        projectName: projectName,
        dueDate: task.day === 'tomorrow' ? addDays_(today, 1) : today,
        createdAt: now.toISOString()
      };
      appendRows_('WorkPulse_Inbox', [[item.id, item.createdAt, item.title, item.projectId, item.projectName, item.dueDate, 'pending']]);
      return { ok: true, item: item };
    });
  });
}

// log = { text, projectId, time: 'HH:mm', minutes, day: 'today' | 'yesterday' }: a log for work done outside the office day.
// It goes into WorkPulse_Logs (kept for good) and WorkPulse_Recent (so the phone and the evening email show it at once).
// The date is the user's own, as for phoneAddTask.
function phoneAddLog(pin, log) {
  return phoneCall_(function () {
    return withLock(function () {
      var check = checkPin(pin);
      if (!check.ok) return check;
      log = log && typeof log === 'object' ? log : {};
      var text = String(log.text == null ? '' : log.text).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 500);
      if (!text) return fail_('bad_request', 'Type what you did first.');
      if (log.day !== 'today' && log.day !== 'yesterday') return fail_('bad_request', 'Pick Today or Yesterday.');
      var tm = /^(\d{2}):(\d{2})$/.exec(typeof log.time === 'string' ? log.time : '');
      if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return fail_('bad_request', 'Pick the time you started.');
      var minutes = Number(log.minutes);
      if (!isFinite(minutes) || minutes % 1 !== 0 || minutes < 1 || minutes > 960) {
        return fail_('bad_request', 'Type how many minutes it took (1 to 960).');
      }
      var projectId = str_(log.projectId).slice(0, 200);
      var projectName = '';
      var projects = projectList_();
      for (var i = 0; i < projects.length; i++) {
        if (projects[i].id === projectId) projectName = projects[i].name;
      }
      var today = todayIn_(userTz_(getMeta_()));
      var date = log.day === 'yesterday' ? addDays_(today, -1) : today;
      var now = new Date();
      var id = 'phone-log-' + now.getTime() + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
      var sheet = getOrCreateLogsSheet();
      upsertRows(sheet, [[now.toISOString(), date, log.time, projectName, text, 'completed', '', '', minutes, 0, 'None', id, '']]);
      appendRows_('WorkPulse_Recent', [[id, date, log.time, projectName, projectId, text, 'completed', minutes, '', '']]);
      return { ok: true, log: { id: id, date: date, time: log.time, project: projectName, projectId: projectId, description: text, status: 'completed', minutes: minutes } };
    });
  });
}

// The next OLDER_LOG_DAYS days that have logs before beforeDate, read from WorkPulse_Logs (newest first).
// nextBefore is the date to pass for the page after this one; more says whether there is one.
function phoneOlderLogs(pin, beforeDate) {
  return phoneCall_(function () {
    var check = checkPin(pin);
    if (!check.ok) return check;
    if (!isDateText_(beforeDate)) return fail_('bad_request');
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('WorkPulse_Logs');
    if (!sheet) return { ok: true, logs: [], nextBefore: beforeDate, more: false };
    var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    var rows = dataRows_(sheet, Math.min(ID_COL, sheet.getMaxColumns()));
    var older = [];
    var dates = {};
    for (var i = 0; i < rows.length; i++) {
      var date = dateText_(rows[i][1], ssTz);
      if (!isDateText_(date) || date >= beforeDate) continue;
      older.push({ row: rows[i], date: date });
      dates[date] = true;
    }
    var dayList = [];
    for (var d in dates) dayList.push(d);
    dayList.sort().reverse();
    var page = dayList.slice(0, OLDER_LOG_DAYS);
    var oldest = page.length ? page[page.length - 1] : beforeDate;
    var logs = [];
    for (var j = 0; j < older.length; j++) {
      if (older[j].date < oldest) continue;
      var r = older[j].row;
      logs.push({
        id: String(r[11] == null ? '' : r[11]), date: older[j].date, time: timeText_(r[2], ssTz), project: String(r[3]),
        description: String(r[4]), status: String(r[5]), minutes: num_(r[8])
      });
    }
    logs.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.time < b.time ? 1 : a.time > b.time ? -1 : 0;
    });
    return { ok: true, logs: logs, nextBefore: oldest, more: dayList.length > OLDER_LOG_DAYS };
  });
}

// ---- Tabs ----

function getTab_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  var headers = TAB_COLUMNS[name];
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#F3F4F6');
    sheet.setFrozenRows(1);
  } else {
    ensureHeaders_(sheet, headers);
  }
  return sheet;
}

// An older tab gets the columns added since: missing columns are made and empty header cells filled. Data and
// the order of the existing columns are never touched.
function ensureHeaders_(sheet, headers) {
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (current[i] === '' || current[i] == null) {
      sheet.getRange(1, i + 1).setValue(headers[i]).setFontWeight('bold').setBackground('#F3F4F6');
    }
  }
}

// Rows 2..last, numCols wide.
function dataRows_(sheet, numCols) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, numCols).getValues();
}

// The data rows of a state tab, or none when the tab does not exist yet.
function readTab_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  return sheet ? dataRows_(sheet, Math.min(TAB_COLUMNS[name].length, sheet.getMaxColumns())) : [];
}

// Writes rows from startRow as plain text, so dates, times and titles stay exactly as sent.
function writeRows_(sheet, startRow, rows) {
  if (rows.length === 0) return;
  var needed = startRow + rows.length - 1;
  if (sheet.getMaxRows() < needed) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  sheet.getRange(startRow, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}

function replaceRows_(name, rows) {
  var sheet = getTab_(name);
  var last = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, TAB_COLUMNS[name].length).clearContent();
  writeRows_(sheet, 2, rows);
}

function appendRows_(name, rows) {
  var sheet = getTab_(name);
  writeRows_(sheet, sheet.getLastRow() + 1, rows);
}

function pendingItems_() {
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rows = readTab_('WorkPulse_Inbox');
  var items = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[6]) !== 'pending') continue;
    items.push({
      id: String(r[0]), title: String(r[2]), projectId: String(r[3]), projectName: String(r[4]),
      dueDate: dateText_(r[5], ssTz), createdAt: isoText_(r[1])
    });
  }
  return items;
}

function projectList_() {
  var rows = readTab_('WorkPulse_Projects');
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] === '') continue;
    list.push({ id: String(rows[i][0]), name: String(rows[i][1]), color: String(rows[i][2]) });
  }
  return list;
}

function getMeta_() {
  try {
    var m = JSON.parse(PropertiesService.getScriptProperties().getProperty('meta') || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch (err) {
    return {};
  }
}

// ---- Values and dates ----

function isArray_(v) {
  return Object.prototype.toString.call(v) === '[object Array]';
}

function isObject_(v) {
  return v !== null && typeof v === 'object' && !isArray_(v);
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function isDateText_(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Sub-task titles as one cell: a title per line, at most 30.
function subTasksText_(list) {
  if (!isArray_(list)) return '';
  var out = [];
  for (var i = 0; i < list.length && out.length < 30; i++) {
    var t = str_(list[i]).replace(/\s+/g, ' ');
    if (t) out.push(t);
  }
  return out.join('\n').slice(0, MAX_CELL);
}

function str_(v) {
  return v == null ? '' : String(v).slice(0, MAX_CELL);
}

function num_(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

// A date cell as 'yyyy-MM-dd'. Sheets turns typed dates into Date objects at midnight in the
// spreadsheet's zone, so they are formatted in that zone.
function dateText_(v, ssTz) {
  if (isDate_(v)) return Utilities.formatDate(v, ssTz, 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

function timeText_(v, ssTz) {
  if (isDate_(v)) return Utilities.formatDate(v, ssTz, 'HH:mm');
  return v == null ? '' : String(v);
}

function isoText_(v) {
  if (isDate_(v)) return v.toISOString();
  return v == null ? '' : String(v);
}

// The user's zone: the one the PC last sent, else the script's.
function userTz_(meta) {
  return meta && meta.tz ? meta.tz : Session.getScriptTimeZone();
}

function todayIn_(tz) {
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

// Calendar arithmetic on 'yyyy-MM-dd' text, done in UTC so no zone or daylight saving shift applies.
function addDays_(dateText, n) {
  var p = dateText.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
`;
