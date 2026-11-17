import { createHash, randomUUID } from 'node:crypto';
import { GOOGLE_APPS_SCRIPT_CODE } from '../utils/googleAppsScriptTemplate';

// Runs the Apps Script text from GOOGLE_APPS_SCRIPT_CODE in Node with fakes for the Google services it
// uses. The fakes copy the real behaviour where it matters for WorkPulse:
// - Sheets turn date-, time- and number-looking text into Date objects and numbers, unless the cell's
//   number format is plain text ('@'); dates are midnight in the spreadsheet's time zone.
// - getRange outside the sheet's rows or columns throws; setValues needs the exact range size.
// - Script Properties store strings only (9 KB per value).
// - Every call/get/run evaluates the script again, like a fresh Apps Script execution (globals reset).
// - The fake script lock throws if waitLock is called while this execution already holds it.

export interface SentMail {
  to: string;
  subject: string;
  htmlBody: string;
  body: string;
}

export interface FakeTrigger {
  fn: string;
  hour?: number;
  minute?: number;
  tz?: string;
  // One-off triggers (timeBased().after(ms)): the delay and the instant they are due.
  afterMs?: number;
  at?: number;
}

export interface FakeHtmlOutput {
  kind: 'html';
  html: string;
  title: string;
  metaTags: { name: string; content: string }[];
  getContent(): string;
}

export interface ScriptHarness {
  call(action: string, payload?: object): any;
  get(params: object): any;
  run(fn: string, ...args: unknown[]): any;
  sheets: Record<string, any[][]>;
  props: Record<string, string>;
  mails: SentMail[];
  triggers: FakeTrigger[];
  readonly lockCalls: number;
  readonly lockHeld: boolean;
  setNow(d: Date): void;
  // true: ScriptApp trigger builders throw on create() (a script without the trigger permission).
  breakTriggers(on: boolean): void;
  // true: another execution holds the script lock (waitLock throws, tryLock answers false) until set to false.
  contendLock(on: boolean): void;
  // A text: every MailApp.sendEmail throws it (null = mail works again).
  failMail(message: string | null): void;
  // Emails left for the day; sendEmail throws the daily-limit error at 0 and each mail uses one.
  setMailQuota(n: number): void;
  // Runs, as fresh executions, every one-off trigger that is due at the current fake time (they stay listed until the script deletes them).
  fireDueTriggers(): number;
}

const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 26;

// Milliseconds to add to a UTC instant to get the wall-clock time in `tz` at that instant.
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant whose wall-clock time in `tz` is the given fields.
export function zonedTime(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return new Date(t);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Utilities.formatDate for the SimpleDateFormat letters the script uses.
export function formatDate(date: Date, tz: string, pattern: string): string {
  if (!(date instanceof Date) || isNaN(date.getTime())) throw new Error('Invalid argument: date');
  const w = new Date(date.getTime() + tzOffsetMs(date.getTime(), tz));
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return pattern.replace(/yyyy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|mm|ss/g, (tok) => {
    switch (tok) {
      case 'yyyy': return String(w.getUTCFullYear());
      case 'MMMM': return FULL_MONTH_NAMES[w.getUTCMonth()];
      case 'MMM': return MONTH_NAMES[w.getUTCMonth()];
      case 'MM': return pad(w.getUTCMonth() + 1);
      case 'M': return String(w.getUTCMonth() + 1);
      case 'dd': return pad(w.getUTCDate());
      case 'd': return String(w.getUTCDate());
      case 'EEEE': return FULL_DAY_NAMES[w.getUTCDay()];
      case 'EEE': return DAY_NAMES[w.getUTCDay()];
      case 'HH': return pad(w.getUTCHours());
      case 'H': return String(w.getUTCHours());
      case 'mm': return pad(w.getUTCMinutes());
      case 'ss': return pad(w.getUTCSeconds());
      default: throw new Error(`formatDate fake: unsupported pattern letters "${tok}"`);
    }
  });
}

export function createScriptHarness(opts: { spreadsheetTz?: string; now?: Date } = {}): ScriptHarness {
  const ssTz = opts.spreadsheetTz ?? 'Asia/Dhaka';
  let nowMs = (opts.now ?? new Date('2026-11-11T06:00:00Z')).getTime();

  const sheets: Record<string, any[][]> = {};
  const textCells: Record<string, Set<string>> = {};
  const size: Record<string, { rows: number; cols: number }> = {};
  const props: Record<string, string> = {};
  const mails: SentMail[] = [];
  const triggers: (FakeTrigger & { id: string })[] = [];
  let lockCalls = 0;
  let lockHeld = false;
  let triggersBroken = false;
  let lockContended = false;
  let mailError: string | null = null;
  let mailQuota = 100;

  // A value written to a cell, as Sheets stores it.
  function stored(name: string, r: number, c: number, v: unknown): unknown {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return new Date(v.getTime());
    if (typeof v === 'object') throw new Error('Sheets cannot store an object in a cell');
    if (typeof v !== 'string' || textCells[name].has(`${r},${c}`)) return v;
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return zonedTime(ssTz, +m[1], +m[2], +m[3]);
    m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
    if (m && +m[1] < 24) return zonedTime(ssTz, 1899, 12, 30, +m[1], +m[2], +(m[3] || 0));
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }

  function cell(name: string, r: number, c: number): unknown {
    const v = sheets[name][r - 1]?.[c - 1];
    if (v === undefined || v === null) return '';
    return v instanceof Date ? new Date(v.getTime()) : v;
  }

  function lastRow(name: string): number {
    const data = sheets[name];
    for (let r = data.length; r >= 1; r--) {
      const row = data[r - 1] || [];
      if (row.some((v) => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  }

  function makeRange(name: string, row: number, col: number, numRows: number, numCols: number) {
    if (!(row >= 1 && col >= 1 && numRows >= 1 && numCols >= 1)) {
      throw new Error('The starting row/column and the number of rows/columns must be at least 1.');
    }
    if (row + numRows - 1 > size[name].rows || col + numCols - 1 > size[name].cols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    const each = (f: (r: number, c: number, i: number, j: number) => void) => {
      for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) f(row + i, col + j, i, j);
    };
    const put = (r: number, c: number, v: unknown) => {
      const data = sheets[name];
      while (data.length < r) data.push([]);
      data[r - 1][c - 1] = v;
    };
    const range = {
      getValues() {
        const out: unknown[][] = [];
        for (let i = 0; i < numRows; i++) {
          const line: unknown[] = [];
          for (let j = 0; j < numCols; j++) line.push(cell(name, row + i, col + j));
          out.push(line);
        }
        return out;
      },
      getValue() {
        return cell(name, row, col);
      },
      setValues(values: unknown[][]) {
        if (!Array.isArray(values) || values.length !== numRows || values.some((l) => !Array.isArray(l) || l.length !== numCols)) {
          throw new Error(`The number of rows or columns in the data does not match the range (${numRows}x${numCols}).`);
        }
        each((r, c, i, j) => put(r, c, stored(name, r, c, values[i][j])));
        return range;
      },
      setValue(v: unknown) {
        each((r, c) => put(r, c, stored(name, r, c, v)));
        return range;
      },
      setNumberFormat(fmt: string) {
        each((r, c) => {
          if (fmt === '@') textCells[name].add(`${r},${c}`);
          else textCells[name].delete(`${r},${c}`);
        });
        return range;
      },
      clearContent() {
        each((r, c) => {
          if (sheets[name][r - 1]) sheets[name][r - 1][c - 1] = '';
        });
        return range;
      },
      setFontWeight: () => range,
      setBackground: () => range,
    };
    return range;
  }

  function makeSheet(name: string) {
    const sheet = {
      getName: () => name,
      getLastRow: () => lastRow(name),
      getLastColumn() {
        let max = 0;
        for (const row of sheets[name]) {
          for (let c = (row || []).length; c >= 1; c--) {
            const v = row[c - 1];
            if (v !== '' && v !== undefined && v !== null) {
              max = Math.max(max, c);
              break;
            }
          }
        }
        return max;
      },
      getMaxRows: () => size[name].rows,
      getMaxColumns: () => size[name].cols,
      insertRowsAfter(_after: number, n: number) {
        size[name].rows += n;
        return sheet;
      },
      insertColumnsAfter(_after: number, n: number) {
        size[name].cols += n;
        return sheet;
      },
      getRange(row: number, col: number, numRows = 1, numCols = 1) {
        return makeRange(name, row, col, numRows, numCols);
      },
      appendRow(values: unknown[]) {
        const r = lastRow(name) + 1;
        if (r > size[name].rows) size[name].rows = r;
        if (values.length > size[name].cols) size[name].cols = values.length;
        makeRange(name, r, 1, 1, values.length).setValues([values]);
        return sheet;
      },
      deleteRows(start: number, n: number) {
        sheets[name].splice(start - 1, n);
        size[name].rows -= n;
      },
      setFrozenRows: () => sheet,
      autoResizeColumns: () => sheet,
    };
    return sheet;
  }

  function addSheet(name: string) {
    if (!sheets[name]) sheets[name] = [];
    textCells[name] = textCells[name] || new Set();
    size[name] = size[name] || { rows: DEFAULT_ROWS, cols: DEFAULT_COLS };
    return makeSheet(name);
  }

  const spreadsheet = {
    getSheetByName: (name: string) => (sheets[name] ? addSheet(name) : null),
    insertSheet(name: string) {
      if (sheets[name]) throw new Error(`A sheet with the name "${name}" already exists.`);
      return addSheet(name);
    },
    getSheets: () => Object.keys(sheets).map(addSheet),
    getSpreadsheetTimeZone: () => ssTz,
    getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE_ID/edit',
  };

  class FakeDate extends Date {
    constructor(...args: any[]) {
      if (args.length === 0) super(nowMs);
      else super(...(args as [any]));
    }
    static now() {
      return nowMs;
    }
  }

  function makeTriggerBuilder(fn: string) {
    const t: FakeTrigger & { id: string } = { fn, id: randomUUID() };
    const b = {
      timeBased: () => b,
      everyDays: () => b,
      atHour: (h: number) => ((t.hour = h), b),
      nearMinute: (m: number) => ((t.minute = m), b),
      inTimezone: (tz: string) => ((t.tz = tz), b),
      after: (ms: number) => ((t.afterMs = ms), (t.at = nowMs + ms), b),
      create() {
        if (triggersBroken) throw new Error('You do not have permission to call ScriptApp.newTrigger.');
        triggers.push(t);
        return { getHandlerFunction: () => t.fn, getUniqueId: () => t.id };
      },
    };
    return b;
  }

  const services = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => {
        const store = {
          getProperty: (k: string) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
          setProperty(k: string, v: unknown) {
            const s = String(v);
            if (Buffer.byteLength(s, 'utf8') > 9 * 1024) throw new Error('Argument too large: value');
            props[k] = s;
            return store;
          },
          deleteProperty(k: string) {
            delete props[k];
            return store;
          },
          getProperties: () => ({ ...props }),
        };
        return store;
      },
    },
    LockService: {
      getScriptLock: () => {
        let mine = false;
        return {
          waitLock(_ms: number) {
            lockCalls++;
            if (lockContended) throw new Error('Lock timeout: another process was holding the lock for too long.');
            if (lockHeld) throw new Error('Fake lock: waitLock called while the script lock is already held');
            lockHeld = true;
            mine = true;
          },
          tryLock(_ms: number) {
            lockCalls++;
            if (lockContended || lockHeld) return false;
            lockHeld = mine = true;
            return true;
          },
          hasLock: () => mine && lockHeld,
          releaseLock() {
            if (mine) lockHeld = mine = false;
          },
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(alg: string, value: string, charset?: string) {
        if (alg !== 'SHA_256') throw new Error('Fake computeDigest supports SHA_256 only');
        if (charset !== undefined && charset !== 'UTF_8') throw new Error('Fake computeDigest supports UTF_8 only');
        const buf = createHash('sha256').update(String(value), 'utf8').digest();
        return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
      },
      formatDate: (d: Date, tz: string, pattern: string) => formatDate(d, tz, pattern),
      base64Encode: (v: string | number[]) =>
        Buffer.from(typeof v === 'string' ? Buffer.from(v, 'utf8') : Uint8Array.from(v.map((b) => b & 255))).toString('base64'),
      getUuid: () => randomUUID(),
    },
    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput(content: string) {
        const out = {
          kind: 'text',
          content,
          mimeType: 'TEXT',
          setMimeType(m: string) {
            out.mimeType = m;
            return out;
          },
          getContent: () => out.content,
        };
        return out;
      },
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      createHtmlOutput(html = '') {
        const out: FakeHtmlOutput & Record<string, any> = {
          kind: 'html',
          html: String(html),
          title: '',
          metaTags: [],
          getContent: () => out.html,
          setTitle(t: string) {
            out.title = t;
            return out;
          },
          addMetaTag(n: string, c: string) {
            out.metaTags.push({ name: n, content: c });
            return out;
          },
          setXFrameOptionsMode: () => out,
        };
        return out;
      },
    },
    MailApp: {
      sendEmail(a: any, subject?: string, body?: string, options?: any) {
        if (mailError !== null) throw new Error(mailError);
        if (mailQuota <= 0) throw new Error('Service invoked too many times for one day: email.');
        mailQuota--;
        const m = typeof a === 'object' ? a : { to: a, subject, body, ...(options || {}) };
        mails.push({ to: m.to, subject: m.subject, htmlBody: m.htmlBody ?? '', body: m.body ?? '' });
      },
      getRemainingDailyQuota: () => mailQuota,
    },
    ScriptApp: {
      getProjectTriggers: () =>
        triggers.map((t) => ({ getHandlerFunction: () => t.fn, getUniqueId: () => t.id })),
      deleteTrigger(tr: { getUniqueId(): string }) {
        const i = triggers.findIndex((t) => t.id === tr.getUniqueId());
        if (i >= 0) triggers.splice(i, 1);
      },
      newTrigger: (fn: string) => makeTriggerBuilder(fn),
    },
    Session: {
      getEffectiveUser: () => ({ getEmail: () => 'owner@gmail.com' }),
      getActiveUser: () => ({ getEmail: () => 'owner@gmail.com' }),
      getScriptTimeZone: () => ssTz,
    },
    Date: FakeDate,
  };

  const names = Object.keys(services);
  const values = names.map((n) => (services as Record<string, unknown>)[n]);

  // A fresh execution: evaluate the whole script, then look a top-level name up.
  function lookup(name: string): any {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Bad function name: ${name}`);
    const factory = new Function(...names, `${GOOGLE_APPS_SCRIPT_CODE}\n;return function (n) { return eval(n); };`);
    return factory(...values)(name);
  }

  function parseOutput(out: any): any {
    if (out && out.kind === 'text') return JSON.parse(out.getContent());
    return out;
  }

  return {
    call(action: string, payload: object = {}) {
      const e = {
        parameter: { action },
        postData: { contents: JSON.stringify({ action, ...payload }), type: 'application/json' },
      };
      return parseOutput(lookup('doPost')(e));
    },
    get(params: object) {
      return parseOutput(lookup('doGet')({ parameter: { ...params } }));
    },
    run(fn: string, ...args: unknown[]) {
      const f = lookup(fn);
      if (typeof f !== 'function') throw new Error(`${fn} is not a function in the script`);
      return f(...args);
    },
    sheets,
    props,
    mails,
    triggers,
    get lockCalls() {
      return lockCalls;
    },
    get lockHeld() {
      return lockHeld;
    },
    setNow(d: Date) {
      nowMs = d.getTime();
    },
    breakTriggers(on: boolean) {
      triggersBroken = on;
    },
    contendLock(on: boolean) {
      lockContended = on;
    },
    failMail(message: string | null) {
      mailError = message;
    },
    setMailQuota(n: number) {
      mailQuota = n;
    },
    fireDueTriggers() {
      const due = triggers.filter((t) => t.at !== undefined && t.at <= nowMs);
      for (const t of due) lookup(t.fn)();
      return due.length;
    },
  };
}
