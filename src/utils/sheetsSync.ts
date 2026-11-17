import { WorkLog } from '../types';
import { isTransientSheetText } from './aiErrors';
import { requestJson } from './net/http';
import { scriptClientTimeoutMs } from './net/scriptTimeouts';

export interface SyncResult {
  success: boolean;
  message: string;
  count?: number;
  /** Set on a failure that is worth trying again later (no connection, a busy or slow Sheet). */
  retryable?: boolean;
}

type ScriptCall = { ok: true; data: Record<string, any> } | { ok: false; message: string; retryable: boolean };

// One call to the user's script through the local proxy. It never throws and never waits longer than the limit for
// that action; only the script's own { status: 'ok' } counts as success (any other page that answers HTTP 200 does not).
async function callScript(scriptUrl: string, action: string, method: 'GET' | 'POST', payload?: Record<string, unknown>): Promise<ScriptCall> {
  const r = await requestJson<Record<string, any>>('/api/sheets/proxy', {
    method: 'POST',
    body: { scriptUrl: scriptUrl.trim(), action, method, ...(payload ? { payload: { action, ...payload } } : {}) },
    timeoutMs: scriptClientTimeoutMs(action),
  });
  if (!r.ok) return { ok: false, message: r.message, retryable: r.retryable };
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  if (data.status === 'ok') return { ok: true, data };
  const said = typeof data.message === 'string' && data.message ? data.message : typeof data.error === 'string' ? data.error : '';
  const code = typeof data.code === 'string' ? data.code : '';
  const detail = typeof data.detail === 'string' ? data.detail : '';
  return { ok: false, message: said, retryable: code === 'busy' || code === 'timeout' || isTransientSheetText(said) || isTransientSheetText(detail) };
}

export async function testSheetConnection(scriptUrl: string): Promise<SyncResult> {
  if (!scriptUrl || !scriptUrl.trim()) {
    return { success: false, message: 'Google Apps Script Web App URL is empty.' };
  }

  const r = await callScript(scriptUrl, 'ping', 'GET');
  if (!r.ok) return { success: false, message: r.message || 'Unexpected response from Google Sheet script.', retryable: r.retryable };

  const data = r.data;
  const version = typeof data.version === 'number' ? data.version : 1;
  // Version 2 still syncs logs; only the phone page and the evening email need version 3.
  let message: string = data.message || 'Connection to Google Sheet verified successfully!';
  if (version < 2) {
    message = 'Connected. Your script is an older version: re-paste the latest script below and redeploy it to stop duplicate rows.';
  } else if (version < 3) {
    message =
      'Connected. Log sync works, but the phone page and evening email need the latest script: re-paste it below, then update your existing deployment (Deploy, Manage deployments, edit, New version).';
  }
  return { success: true, message };
}

// What is sent for one log: the image becomes a flag (keeps the sheet fast) and the activity
// source ids stay on this device.
export function toSheetLog(log: WorkLog) {
  const { sourceIds: _omit, ...rest } = log;
  return { ...rest, imageBase64: log.imageBase64 ? 'true' : '' };
}

export async function syncSingleLogToSheet(scriptUrl: string, log: WorkLog): Promise<SyncResult> {
  if (!scriptUrl || !scriptUrl.trim()) {
    // If not configured, we gracefully remain in local-storage mode
    return { success: true, message: 'Saved to local storage (Google Sheet URL not configured).' };
  }

  const r = await callScript(scriptUrl, 'appendLog', 'POST', { log: toSheetLog(log) });
  if (r.ok) return { success: true, message: 'Synchronized with Google Sheet.' };
  return { success: false, message: r.message || 'Sheet sync response was not OK.', retryable: r.retryable };
}

export async function syncBatchLogsToSheet(scriptUrl: string, logs: WorkLog[]): Promise<SyncResult> {
  if (!scriptUrl || !scriptUrl.trim()) {
    return { success: false, message: 'Google Apps Script Web App URL is not configured in Settings.' };
  }

  const r = await callScript(scriptUrl, 'batchSync', 'POST', { logs: logs.map(toSheetLog) });
  if (r.ok) {
    const count = r.data.syncedCount || logs.length;
    return { success: true, message: `Successfully synced ${count} logs to Google Sheet!`, count };
  }
  return { success: false, message: r.message || 'Batch sync failed.', retryable: r.retryable };
}
