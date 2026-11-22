import { describe, expect, it } from 'vitest';
import { APPS_SCRIPT_OAUTH_SCOPES, GOOGLE_APPS_SCRIPT_CODE } from './googleAppsScriptTemplate';

// Each Google service the script calls needs a permission. A new service must add its scope to APPS_SCRIPT_OAUTH_SCOPES
// (shown in Settings as the lines to put in appsScript.json), or deployments that list scopes refuse the call.
const SCOPE_OF: Record<string, string | null> = {
  SpreadsheetApp: 'https://www.googleapis.com/auth/spreadsheets',
  MailApp: 'https://www.googleapis.com/auth/script.send_mail',
  ScriptApp: 'https://www.googleapis.com/auth/script.scriptapp',
  Session: 'https://www.googleapis.com/auth/userinfo.email',
  UrlFetchApp: 'https://www.googleapis.com/auth/script.external_request',
  // these need no permission
  ContentService: null,
  HtmlService: null,
  LockService: null,
  PropertiesService: null,
  Utilities: null,
};

describe('Apps Script permissions', () => {
  const used = [...new Set(GOOGLE_APPS_SCRIPT_CODE.match(/\b[A-Z][A-Za-z]+App\b|\b(?:ContentService|HtmlService|LockService|PropertiesService|CacheService|Utilities|Session)\b/g) ?? [])];

  it('uses only services whose permission is known', () => {
    for (const name of used) expect(Object.keys(SCOPE_OF), `${name} is not in SCOPE_OF`).toContain(name);
  });

  it('lists the permission of every service it uses', () => {
    for (const name of used) {
      const scope = SCOPE_OF[name];
      if (scope) expect(APPS_SCRIPT_OAUTH_SCOPES).toContain(scope);
    }
  });
});
