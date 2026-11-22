import { SCRIPT_CORE } from './appsScript/core';
import { SCRIPT_EMAIL } from './appsScript/email';
import { SCRIPT_PHONE } from './appsScript/phonePage';
import { SCRIPT_BACKUP } from './appsScript/backup';

const HEADER = `/**
 * =========================================================================
 * WorkPulse - Google Sheets Sync Backend (version 8)
 * =========================================================================
 *
 * INSTRUCTIONS TO DEPLOY (first time):
 * 1. In your Google Sheet, click on "Extensions" > "Apps Script".
 * 2. Delete all existing code in the editor, and paste this entire script.
 * 3. Click the disk icon (Save).
 * 4. Click the blue "Deploy" button (top right) > "New deployment".
 * 5. Click the gear icon next to "Select type" and choose "Web app".
 * 6. Set:
 *    - Description: "WorkPulse Sync API"
 *    - Execute as: "Me (your email)"
 *    - Who has access: "Anyone" (crucial for WorkPulse to connect)
 * 7. Click "Deploy". Grant permissions if prompted by Google.
 * 8. Copy the "Web app URL" (ends in /exec) and paste it into WorkPulse Settings!
 *
 * UPDATING FROM AN OLDER VERSION (keeps your link working):
 * 1. Paste this entire script over the old code and click Save.
 * 2. Click "Deploy" > "Manage deployments", click the pencil (edit) icon on your
 *    existing deployment, set "Version" to "New version" and click "Deploy".
 *    Do NOT use "New deployment": it makes a new URL and breaks the link saved in WorkPulse.
 * 3. Google asks for permissions again. This version can also send you an evening
 *    email and standup emails (to your own address) and run timers for them; allow all.
 * 4. In WorkPulse Settings, set the phone PIN.
 */
`;

// The log sync code: appendLog / batchSync into the WorkPulse_Logs tab (12 columns of version 2, then Origin) with the Id upsert,
// under the script lock. doPost (in SCRIPT_CORE) hands every action it does not know to handleLogAction_.
const LOGS_SCRIPT = `
// One log as a sheet row: 12 fixed columns (the 12th is the Id) and the 13th, Origin ('auto' for a log WorkPulse wrote itself, else empty).
function logRow_(l) {
  return [
    l.createdAt || new Date().toISOString(),
    l.date || '',
    l.time || '',
    l.projectName || '',
    l.description || '',
    l.status || 'completed',
    (l.tags || []).join(', '),
    l.linkUrl || '',
    l.durationMinutes || 0,
    l.energyRating || 0,
    l.imageBase64 ? 'Yes (Image Attached)' : 'None',
    l.id || '',
    l.origin === 'auto' ? 'auto' : ''
  ];
}

// Log writes run under the script lock. When another run holds it for 20 s, nothing is written and the answer is
// the busy code, so the desktop sends the same request again later (the Id upsert makes that safe).
function handleLogAction_(action, contents) {
  if (action !== 'appendLog' && action !== 'batchSync') {
    return jsonOut_({ status: 'ok', message: 'Action completed' });
  }
  if (action === 'appendLog' && !contents.log) {
    throw new Error('No log payload provided');
  }
  var res = tryLocked_(function () {
    var sheet = getOrCreateLogsSheet();
    if (action === 'appendLog') {
      upsertRows(sheet, [logRow_(contents.log)]);
      return { status: 'ok', message: 'Log successfully saved to Google Sheet', id: contents.log.id };
    }
    var logs = contents.logs || [];
    var rows = [];
    for (var i = 0; i < logs.length; i++) rows.push(logRow_(logs[i]));
    upsertRows(sheet, rows);
    return { status: 'ok', syncedCount: rows.length };
  });
  return jsonOut_(res.got ? res.value : busyAnswer_());
}

function getOrCreateLogsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('WorkPulse_Logs');
  var headers = [
    'Timestamp',
    'Date',
    'Time',
    'Project',
    'Description',
    'Status',
    'Tags',
    'Link',
    'Duration_Minutes',
    'Energy_Rating',
    'Proof_Attached',
    'Id',
    'Origin'
  ];

  if (!sheet) {
    sheet = ss.insertSheet('WorkPulse_Logs');
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#F3F4F6');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  }

  // Older sheets: make sure the Id (12th) and Origin (13th) columns exist and have their headers. Nothing else moves.
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  for (var c = ID_COL; c <= headers.length; c++) {
    if (!sheet.getRange(1, c).getValue()) {
      sheet.getRange(1, c).setValue(headers[c - 1]).setFontWeight('bold').setBackground('#F3F4F6');
    }
  }

  return sheet;
}

// Column 12 holds the WorkPulse log id. Rows are updated in place when the id already exists,
// so sending the same log twice never creates a duplicate row. Runs under the script lock (reused when
// the caller already holds it).
var ID_COL = 12;

function upsertRows(sheet, rows) {
  if (rows.length === 0) return;
  var res = tryLocked_(function () {
    var index = {};
    var last = sheet.getLastRow();
    if (last >= 2) {
      var ids = sheet.getRange(2, ID_COL, last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (ids[i][0]) index[ids[i][0]] = i + 2;
      }
    }
    var fresh = [];
    var freshAt = {};
    for (var r = 0; r < rows.length; r++) {
      var id = rows[r][ID_COL - 1];
      if (id && index[id]) {
        sheet.getRange(index[id], 1, 1, rows[r].length).setValues([rows[r]]);
      } else if (id && freshAt[id] !== undefined) {
        fresh[freshAt[id]] = rows[r];
      } else {
        if (id) freshAt[id] = fresh.length;
        fresh.push(rows[r]);
      }
    }
    if (fresh.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, fresh[0].length).setValues(fresh);
    }
  });
  if (!res.got) throw new Error('The Sheet is busy: the script lock was not free within 20 seconds.');
}
`;

export const GOOGLE_APPS_SCRIPT_CODE = HEADER + LOGS_SCRIPT + SCRIPT_CORE + SCRIPT_EMAIL + SCRIPT_BACKUP + SCRIPT_PHONE;

/**
 * The permissions the script needs, for the "oauthScopes" part of the project's appsScript.json. A project whose manifest lists
 * scopes explicitly (or whose owner never approved the newer ones) is refused with "you do not have permission to call ...".
 * Keep it in step with the services the script uses (a test in googleAppsScriptTemplate.test.ts pins this).
 */
export const APPS_SCRIPT_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.send_mail',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/userinfo.email',
  // UrlFetchApp: the Sheet's own Gemini call for the standup email (version 8). Without it the standup uses plain wording.
  'https://www.googleapis.com/auth/script.external_request',
];

export const APPS_SCRIPT_SCOPES_SNIPPET = `"oauthScopes": [\n${APPS_SCRIPT_OAUTH_SCOPES.map((s) => `    "${s}"`).join(',\n')}\n  ],`;
