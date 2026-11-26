import { plainSheetMessage } from './aiErrors';
import { requestJson, type NetFailKind } from './net/http';
import { scriptClientTimeoutMs } from './net/scriptTimeouts';
import type { InboxItem, PhoneClockOut, PhoneSnapshot } from './phoneSync';

// Calls to the user's Google Apps Script through the local /api/sheets/proxy. The PIN and the token
// travel only in the POST body, never in a URL. Every call has a time limit and always comes back as a
// result with a plain sentence (see ./net/http); the proxy answers its own failures with a code.

export interface PhoneApiResult<T = unknown> {
  ok: boolean;
  message: string;
  code?: string;
  data?: T;
  /** Set on a failure that is worth trying again later (no connection, a busy Sheet, a timeout). */
  retryable?: boolean;
}

const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

const CODE_MESSAGES: Record<string, string> = {
  no_pin: 'No phone PIN is set yet. Set one in Settings.',
  bad_pin: 'That PIN is not right.',
  bad_token: 'This computer is not linked to the phone page any more. Use Reset phone access in Settings (it asks for your current PIN).',
  locked: 'Too many wrong PINs. Try again in 15 minutes.',
  bad_request: 'The Sheet script did not understand the request. Update and redeploy the script.',
  bad_response: 'The Sheet script did not answer as expected. Update and redeploy the script.',
  busy: 'The Sheet is busy with another request. WorkPulse will try again.',
  mail_failed: 'Google could not send the email just now.',
  script_old: 'Your Sheet script is older than version 6. Re-paste the latest script and update your existing deployment.',
  timeout: 'The Sheet did not answer in time. WorkPulse will try again later.',
  unreachable: 'WorkPulse could not reach Google from this computer. Check the internet connection, then try again.',
  not_deployed: 'Google returned a web page instead of the script response. Deploy the script as a Web app with "Who has access" set to "Anyone", and check the URL ends in /exec.',
  server_down: 'WorkPulse could not reach its server. Check that it is still running, then try again.',
};

// Codes that mean "not now": the same request can work later without anyone changing anything.
const RETRYABLE_CODES = new Set(['busy', 'timeout', 'unreachable', 'server_down', 'proxy_error', 'google_error']);

function failure(raw: string | undefined, code?: string, retryable?: boolean): PhoneApiResult<never> {
  // A message the script wrote itself is already a plain sentence; only technical text from the
  // network or the proxy goes through plainSheetMessage.
  const own = (raw || '').trim();
  const message = code ? own || CODE_MESSAGES[code] || plainSheetMessage('', online()) : plainSheetMessage(raw, online());
  const result: PhoneApiResult<never> = { ok: false, message: message.length > 200 ? `${message.slice(0, 197)}...` : message };
  if (code) result.code = code;
  if (retryable || (code !== undefined && RETRYABLE_CODES.has(code))) result.retryable = true;
  return result;
}

// What the app says when the request itself failed and the server gave no code of its own.
const KIND_CODES: Partial<Record<NetFailKind, string>> = { timeout: 'timeout', 'server-down': 'server_down', 'bad-response': 'bad_response' };

async function call<T>(
  url: string,
  action: string,
  fields: Record<string, unknown>,
  okMessage: string,
): Promise<PhoneApiResult<T>> {
  const scriptUrl = (url || '').trim();
  if (!scriptUrl) return failure('Google Apps Script Web App URL is not set in Settings.', 'no_url');

  const r = await requestJson<unknown>('/api/sheets/proxy', {
    method: 'POST',
    body: { scriptUrl, action, method: 'POST', payload: { action, ...fields } },
    timeoutMs: scriptClientTimeoutMs(action),
  });

  if (!r.ok) {
    // The request itself failed (no answer from WorkPulse's server, too slow, a cancel): the code's plain sentence says it.
    if (r.kind !== 'http') return failure(r.kind === 'aborted' ? r.message : undefined, KIND_CODES[r.kind], r.retryable);
    // The proxy answers its own failures (Google unreachable, no answer in time, not deployed) with a code and a plain
    // sentence. With a code, the code decides whether trying again can help; without one, the HTTP status does.
    const said = (r.data && typeof r.data === 'object' ? r.data : {}) as { code?: unknown };
    const code = typeof said.code === 'string' ? said.code : undefined;
    return failure(r.message, code, code ? undefined : r.retryable);
  }

  const body = r.data as { status?: unknown; code?: unknown; message?: unknown; error?: unknown } | null;
  if (!body || typeof body !== 'object') return failure(undefined, 'bad_response');
  if (body.status === 'ok') return { ok: true, message: okMessage, data: body as T };
  const code = typeof body.code === 'string' ? body.code : undefined;
  return failure((body.message || body.error) as string | undefined, code);
}

export function setPhonePin(
  url: string,
  pin: string,
  auth: { token?: string; oldPin?: string },
): Promise<PhoneApiResult<{ token: string }>> {
  const fields: Record<string, unknown> = { pin };
  if (auth.token) fields.token = auth.token;
  if (auth.oldPin) fields.oldPin = auth.oldPin;
  return call(url, 'setPin', fields, 'Phone PIN saved.');
}

export function pushState(url: string, token: string, snapshot: PhoneSnapshot): Promise<PhoneApiResult> {
  return call(url, 'pushState', { token, ...snapshot }, 'Phone page updated.');
}

/** `clockOuts` comes from script version 10 (the phone page's clock-outs this computer has not taken yet). */
export function pullInbox(url: string, token: string): Promise<PhoneApiResult<{ items: InboxItem[]; clockOuts?: PhoneClockOut[] }>> {
  return call(url, 'pullInbox', { token }, 'Inbox checked.');
}

/** `clockOutIds` marks phone clock-outs taken (script version 10; an older script ignores the field). */
export function ackInbox(url: string, token: string, ids: string[], clockOutIds: string[] = []): Promise<PhoneApiResult> {
  return call(url, 'ackInbox', clockOutIds.length > 0 ? { token, ids, clockOutIds } : { token, ids }, 'Inbox cleared.');
}

/** The first script version that sends "when I clock out" emails by itself (a timer in the Sheet), with its own Gemini call. */
export const SHEET_SENDS_SCRIPT_VERSION = 8;

/**
 * `when` and `geminiKey` need script version 8 (an older script ignores them, so only send them to version 8).
 * geminiKey: a text saves it in the script ('' removes it); left out keeps the saved one.
 */
/** The first script version that takes Google's newer Gemini keys ('AQ.' with dots) and never fails the email save over a key. */
export const DOTTED_KEY_SCRIPT_VERSION = 11;

/**
 * The Gemini key to send with setEmail, or undefined to leave it out (the script keeps the one it has). A script before
 * version 11 rejects the whole save, timer included, over a key with a dot, so such a key is not sent to it.
 */
export function geminiKeyForScript(key: string | undefined, version: number): string | undefined {
  const k = (key ?? '').trim();
  if (version >= DOTTED_KEY_SCRIPT_VERSION || k === '' || /^[A-Za-z0-9_-]{10,200}$/.test(k)) return k;
  return undefined;
}

export function setEmailSchedule(
  url: string,
  token: string,
  cfg: { enabled: boolean; hour: number; minute: number; tz: string; to?: string; when?: 'clockout' | 'fixed'; geminiKey?: string },
): Promise<PhoneApiResult> {
  return call(url, 'setEmail', { token, ...cfg }, cfg.enabled ? 'Evening email is on.' : 'Evening email is off.');
}

export function sendTestEmail(url: string, token: string): Promise<PhoneApiResult> {
  return call(url, 'sendTestEmail', { token }, 'Test email sent.');
}

export interface SheetBackupVersion {
  version: number;
  savedAt: string;
  counts: { logs: number; tasks: number; projects: number };
}

export function saveBackupToSheet(
  url: string,
  token: string,
  backup: string,
  meta: { counts: { logs: number; tasks: number; projects: number }; exportedAt: string },
): Promise<PhoneApiResult<{ version: number; savedAt: string }>> {
  return call(url, 'saveBackup', { token, backup, meta }, 'Copied to the Sheet.');
}

export async function getBackupInfo(url: string, token: string): Promise<PhoneApiResult<{ versions: SheetBackupVersion[] }>> {
  const r = await call<{ versions?: unknown }>(url, 'backupInfo', { token }, 'Checked the Sheet.');
  if (!r.ok) return r as PhoneApiResult<never>;
  const raw = Array.isArray(r.data?.versions) ? (r.data?.versions as unknown[]) : [];
  const versions: SheetBackupVersion[] = [];
  for (const v of raw) {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
    if (typeof o.version !== 'number' || typeof o.savedAt !== 'string') continue;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    versions.push({ version: o.version, savedAt: o.savedAt, counts: { logs: n(o.counts?.logs), tasks: n(o.counts?.tasks), projects: n(o.counts?.projects) } });
  }
  return { ok: true, message: r.message, data: { versions } };
}

export async function loadBackupFromSheet(
  url: string,
  token: string,
  version?: number,
): Promise<PhoneApiResult<{ backup: string; savedAt: string }>> {
  const fields: Record<string, unknown> = { token };
  if (version !== undefined) fields.version = version;
  const r = await call<{ backup?: unknown; savedAt?: unknown }>(url, 'loadBackup', fields, 'Read the copy from the Sheet.');
  if (!r.ok) return r as PhoneApiResult<never>;
  if (typeof r.data?.backup !== 'string' || !r.data.backup) {
    return { ok: false, message: 'The Sheet sent back an empty copy. Update the script and try again.', code: 'bad_response' };
  }
  return { ok: true, message: r.message, data: { backup: r.data.backup, savedAt: typeof r.data.savedAt === 'string' ? r.data.savedAt : '' } };
}

/** The first script version that has saveHistory, sendDayEmail, emailStatus and cancelDayEmail. Gate desktop features on `getScriptVersion(url) >= HISTORY_SCRIPT_VERSION`. */
export const HISTORY_SCRIPT_VERSION = 6;

const OLD_SCRIPT = 'Your Sheet script is older than version 6. Re-paste the latest script and update your existing deployment (Deploy, Manage deployments, edit, New version).';

// A script older than version 6 does not know these actions and answers any unknown action with { status: 'ok' }, so the
// answer must carry this version's own fields to count.
async function needsV6<T>(r: PhoneApiResult<T>, proves: (d: Record<string, unknown>) => boolean): Promise<PhoneApiResult<T>> {
  if (!r.ok) return r;
  const d = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
  return proves(d) ? r : { ok: false, message: OLD_SCRIPT, code: 'script_old' };
}

export interface DayHistoryRow {
  date: string;
  clockIn?: string;
  clockOut?: string;
  workedMinutes: number;
  loggedMinutes: number;
  logCount: number;
  closedAt?: string;
}

export interface StandupRow {
  id: string;
  kind: 'day' | 'week';
  from: string;
  to: string;
  text: string;
  writer: string;
  createdAt: string;
  editedAt?: string;
}

/** Adds or updates the day history and standup rows in the Sheet (script version 6). Rows are keyed by date / id; nothing is deleted. */
export async function saveHistory(
  url: string,
  token: string,
  history: { days?: DayHistoryRow[]; standups?: StandupRow[] },
): Promise<PhoneApiResult<{ days: number; standups: number }>> {
  const r = await call<{ days?: unknown; standups?: unknown }>(url, 'saveHistory', { token, days: history.days ?? [], standups: history.standups ?? [] }, 'History saved to the Sheet.');
  return needsV6(r, (d) => typeof d.days === 'number' && typeof d.standups === 'number') as Promise<PhoneApiResult<{ days: number; standups: number }>>;
}

/** What identifies one standup email: a day, or a week from its first to its last day. */
export type DayEmailTarget = { kind: 'day'; date: string } | { kind: 'week'; from: string; to: string };

/** The key the script uses for a target (the same one emailStatus reports). */
export function dayEmailKey(t: DayEmailTarget): string {
  return t.kind === 'day' ? `day|${t.date}|${t.date}` : `week|${t.from}|${t.to}`;
}

export type DayEmailState = 'sent' | 'pending' | 'failed' | 'skipped';

export interface DayEmailAnswer {
  state: DayEmailState;
  key: string;
  sendAt?: string;
  sentAt?: string;
  duplicate?: boolean;
}

/** Mails the standup text saved for the target (script version 6). At most once per key; `delayMinutes` above 0 sends it later. */
export async function sendDayEmail(
  url: string,
  token: string,
  target: DayEmailTarget,
  opts: { delayMinutes?: number; requestId?: string } = {},
): Promise<PhoneApiResult<DayEmailAnswer>> {
  const r = await call<DayEmailAnswer>(url, 'sendDayEmail', { token, ...target, delayMinutes: opts.delayMinutes ?? 0, requestId: opts.requestId }, 'Standup email handled.');
  return needsV6(r, (d) => typeof d.state === 'string');
}

export interface DayEmailStatus {
  key: string;
  state: 'sent' | 'pending' | 'failed';
  tries: number;
  sentAt?: string;
  sendAt?: string;
  error?: string;
  willRetry?: boolean;
}

/** Sent, waiting or failed for the given targets (all of them when none are given; script version 6). */
export async function getEmailStatus(url: string, token: string, targets?: DayEmailTarget[]): Promise<PhoneApiResult<{ items: DayEmailStatus[] }>> {
  const fields: Record<string, unknown> = { token };
  if (targets) fields.keys = targets.map(dayEmailKey);
  const r = await call<{ items?: unknown }>(url, 'emailStatus', fields, 'Checked the standup emails.');
  const proved = await needsV6(r, (d) => Array.isArray(d.items));
  if (!proved.ok) return proved as PhoneApiResult<never>;
  const items = ((proved.data?.items as unknown[]) ?? []).filter((x): x is DayEmailStatus => !!x && typeof x === 'object' && typeof (x as DayEmailStatus).key === 'string');
  return { ok: true, message: proved.message, data: { items } };
}

/** Stops a waiting standup email (script version 6). A sent email stays sent. */
export async function cancelDayEmail(url: string, token: string, target: DayEmailTarget): Promise<PhoneApiResult<{ cancelled: boolean }>> {
  const r = await call<{ cancelled?: unknown }>(url, 'cancelDayEmail', { token, ...target }, 'Standup email cancelled.');
  return needsV6(r, (d) => typeof d.cancelled === 'boolean') as Promise<PhoneApiResult<{ cancelled: boolean }>>;
}

export function resetPhoneAccess(
  url: string,
  pin: string,
  newPin: string,
): Promise<PhoneApiResult<{ token: string }>> {
  return call(url, 'resetAccess', { pin, newPin }, 'Phone access reset.');
}

/**
 * What a ping of the script found. `unreachable` is a problem of the moment (no internet, Google slow, WorkPulse's own
 * server busy): the version is unknown, not old. `not-workpulse` means something answered that is not WorkPulse's script
 * (a wrong URL, or a script not shared with "Anyone").
 */
export type ScriptProbe =
  | { kind: 'ok'; version: number }
  | { kind: 'no-url' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'not-workpulse'; message: string };

export async function probeScript(url: string): Promise<ScriptProbe> {
  const scriptUrl = (url || '').trim();
  if (!scriptUrl) return { kind: 'no-url' };
  const r = await requestJson<{ status?: unknown; version?: unknown }>('/api/sheets/proxy', {
    method: 'POST',
    body: { scriptUrl, action: 'ping', method: 'GET' },
    timeoutMs: scriptClientTimeoutMs('ping'),
  });
  if (r.ok) {
    const body = r.data;
    if (body && typeof body === 'object' && body.status === 'ok') return { kind: 'ok', version: typeof body.version === 'number' ? body.version : 1 };
    return { kind: 'not-workpulse', message: CODE_MESSAGES.not_deployed };
  }
  const said = (r.data && typeof r.data === 'object' ? r.data : {}) as { code?: unknown };
  if (said.code === 'not_deployed') return { kind: 'not-workpulse', message: r.message };
  // Anything else that failed (no connection, a timeout, WorkPulse's own server) is a problem of the moment.
  return { kind: 'unreachable', message: r.message };
}

// The script's version from its ping, or null when it cannot be reached or is not WorkPulse's script.
export async function getScriptVersion(url: string): Promise<number | null> {
  const p = await probeScript(url);
  return p.kind === 'ok' ? p.version : null;
}
