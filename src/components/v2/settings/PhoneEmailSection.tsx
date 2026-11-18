import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import type { AppSettings } from '../../../types';
import type { PhoneSyncStatus } from '../../../hooks/usePhoneSync';
import { getScriptVersion, resetPhoneAccess, sendTestEmail, setEmailSchedule, setPhonePin } from '../../../utils/phoneApi';
import { APPS_SCRIPT_SCOPES_SNIPPET } from '../../../utils/googleAppsScriptTemplate';
import { emailWhenOf, type EmailWhen } from '../../../utils/emailWhen';
import { DEFAULT_EMAIL_TIME, cleanRecipients, emailTimeAllowed, parseEmailTime, phoneLink } from '../../../utils/phoneSettings';
import { GOOGLE_APPS_SCRIPT_CODE } from '../../../utils/googleAppsScriptTemplate';
import { localDateOfIso, localDateStr, localTimeStr } from '../../../utils/dates';
import { dayLabelLong } from '../../../utils/taskSections';
import { SheetBackupBlock, type SheetBackupControls } from './SheetBackupBlock';

interface PhoneEmailSectionProps {
  settings: AppSettings;
  /** Saves only these fields at once, onto the newest settings; the rest of Settings still waits for Save. */
  onUpdateSettings(patch: Partial<AppSettings>): void;
  status: PhoneSyncStatus;
  sheetBackup: SheetBackupControls;
  onNotify(msg: string, type?: 'success' | 'error' | 'info'): void;
  /** The URL typed in the Google Sheet box is not the saved one: this section still uses the saved one. */
  urlUnsaved?: boolean;
  /** The same as the sticky Save All Settings button. */
  onSaveAll?(): void;
}

const LABEL = 'block mb-1 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';
const FIELD = 'v2-input w-full h-11 px-3 text-[length:var(--fs-body)]';
const BTN =
  'v2-btn inline-flex items-center justify-center gap-1.5 min-h-11 px-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const TEXT_BTN =
  'min-h-8 pointer-coarse:min-h-11 px-1 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 cursor-pointer disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed';
const HINT = 'text-[length:var(--fs-small)] text-[var(--text-muted)]';
const SUB = 'text-[length:var(--fs-body)] font-bold text-[var(--text-main)]';

// The script and the phone keypad both use exactly 4 digits.
const PIN_RE = /^\d{4}$/;

type PinMode = 'none' | 'set' | 'change' | 'reset';
type Result = { ok: boolean; message: string } | null;

/** Shown when Google refuses a permission: how to let the script use mail, timers and the owner's address. */
const PermissionHelp: React.FC<{ open: boolean; onNotify: PhoneEmailSectionProps['onNotify'] }> = ({ open, onNotify }) => (
  <details open={open} className="w-full text-[length:var(--fs-small)] text-[var(--text-main)]">
    <summary className="cursor-pointer font-semibold min-h-8">Google says a permission is missing?</summary>
    <ol className="list-decimal pl-5 mt-2 flex flex-col gap-2">
      <li>Open your Sheet, then <strong>Extensions &gt; Apps Script</strong>.</li>
      <li>On the left, click the <strong>gear icon (Project Settings)</strong>, then tick <strong>Show &quot;appsScript.json&quot; manifest file in editor</strong>.</li>
      <li>Go back to the <strong>Editor</strong> (the &lt;/&gt; icon) and click <strong>appsScript.json</strong> in the file list.</li>
      <li>
        Add (or replace) the <code>oauthScopes</code> part with the lines below. Keep your other lines (such as <code>timeZone</code> and{' '}
        <code>webapp</code>) as they are, and mind the commas.
        <pre className="mt-2 p-2 overflow-x-auto rounded-[var(--radius-btn)] border border-[var(--border-control)] bg-[var(--bg-subtle)]">{APPS_SCRIPT_SCOPES_SNIPPET}</pre>
        <button
          type="button"
          className={`${BTN} mt-2`}
          onClick={() =>
            navigator.clipboard?.writeText(APPS_SCRIPT_SCOPES_SNIPPET).then(
              () => onNotify('Copied. Paste it into appsScript.json.', 'success'),
              () => onNotify('Could not copy to the clipboard.', 'error'),
            )
          }
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          <span>Copy these lines</span>
        </button>
      </li>
      <li>
        Press <strong>Save</strong>. At the top choose the function <code>authorizeWorkPulse</code> and press <strong>Run</strong>. Google
        asks for permission: click <strong>Review permissions</strong> and <strong>Allow</strong> (if it warns the app is not verified:
        Advanced, then Go to …, then Allow). Then open <strong>Execution log</strong> at the bottom: every line should start with{' '}
        <code>OK</code>. A line starting with <code>MISSING</code> names what is still blocked: send me that line.
      </li>
      <li>Last: <strong>Deploy &gt; Manage deployments</strong>, the pencil, Version <strong>New version</strong>, <strong>Deploy</strong>. Then try again here.</li>
    </ol>
  </details>
);

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function when(iso: string): string {
  const d = new Date(iso);
  const date = localDateOfIso(iso);
  return date === localDateStr() ? localTimeStr(d) : `${dayLabelLong(date)} at ${localTimeStr(d)}`;
}

const ResultLine: React.FC<{ result: Result }> = ({ result }) =>
  result ? (
    <p role={result.ok ? 'status' : 'alert'} className={`text-[length:var(--fs-small)] ${result.ok ? 'text-success' : 'text-danger'}`}>
      {result.message}
    </p>
  ) : null;

/** The update steps, shared by the old-script notice and the setup help. */
const SetupSteps: React.FC<{ onCopy(): void; copied: boolean }> = ({ onCopy, copied }) => (
  <ol className="list-decimal pl-5 flex flex-col gap-2 text-[length:var(--fs-small)] text-[var(--text-main)]">
    <li>
      Copy the script and paste it into your Sheet's Apps Script (Extensions &gt; Apps Script), replacing the old code.
      <div className="mt-2">
        <button type="button" onClick={onCopy} className={BTN}>
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          <span>{copied ? 'Copied' : 'Copy script'}</span>
        </button>
      </div>
    </li>
    <li>
      Choose <strong>Deploy &gt; Manage deployments</strong>, edit the existing deployment (the pencil), set Version to{' '}
      <strong>New version</strong> and press Deploy. Do not choose New deployment: it changes the link WorkPulse uses.
    </li>
    <li>Allow the permissions Google asks for: your Sheet, sending email to you, and a daily timer.</li>
    <li>Come back here and set the phone PIN.</li>
  </ol>
);

export const PhoneEmailSection: React.FC<PhoneEmailSectionProps> = ({ settings, onUpdateSettings, status, sheetBackup, onNotify, urlUnsaved, onSaveAll }) => {
  const uid = useId();
  const url = settings.googleScriptUrl || '';
  const token = settings.phoneToken || '';
  const link = phoneLink(url);

  // undefined = checking, null = could not reach
  const [version, setVersion] = useState<number | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const [mode, setMode] = useState<PinMode>('none');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinResult, setPinResult] = useState<Result>(null);

  const savedTime = parseEmailTime(settings.emailTime) ? (settings.emailTime as string) : DEFAULT_EMAIL_TIME;
  const [emailOn, setEmailOn] = useState(settings.emailEnabled === true);
  const [emailTime, setEmailTime] = useState(savedTime);
  const [emailWhen, setEmailWhen] = useState<EmailWhen>(emailWhenOf(settings));
  const [emailTo, setEmailTo] = useState(settings.emailTo ?? '');
  const [emailBusy, setEmailBusy] = useState<'save' | 'test' | null>(null);
  const [emailResult, setEmailResult] = useState<Result>(null);

  // Bumped on every check, so an answer for an older URL or an older check is ignored.
  const checkId = useRef(0);
  const check = useCallback(() => {
    const id = ++checkId.current;
    if (!url) return;
    setVersion(undefined);
    getScriptVersion(url)
      .catch(() => null)
      .then((v) => {
        if (id === checkId.current) setVersion(v);
      });
  }, [url]);

  useEffect(() => {
    check();
    return () => {
      checkId.current++;
    };
  }, [check]);

  const copyScript = () => {
    navigator.clipboard?.writeText(GOOGLE_APPS_SCRIPT_CODE).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      },
      () => onNotify('Could not copy to the clipboard.', 'error'),
    );
  };

  const copyLink = () => {
    if (!link) return;
    navigator.clipboard?.writeText(link).then(
      () => onNotify('Phone link copied', 'success'),
      () => onNotify('Could not copy to the clipboard.', 'error'),
    );
  };

  const openMode = (m: PinMode) => {
    setMode(m);
    setPin('');
    setPin2('');
    setCurrentPin('');
    setPinResult(null);
  };

  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'reset' && !PIN_RE.test(currentPin)) {
      setPinResult({ ok: false, message: 'Enter your current PIN: 4 digits.' });
      return;
    }
    if (!PIN_RE.test(pin)) {
      setPinResult({ ok: false, message: 'The new PIN must be 4 digits.' });
      return;
    }
    if (pin !== pin2) {
      setPinResult({ ok: false, message: 'The two PINs are not the same. Type them again.' });
      return;
    }
    setPinBusy(true);
    setPinResult(null);
    const r =
      mode === 'reset' ? await resetPhoneAccess(url, currentPin, pin) : await setPhonePin(url, pin, { token: token || undefined });
    setPinBusy(false);
    const newToken = r.ok ? r.data?.token : undefined;
    if (!newToken) {
      setPinResult({ ok: false, message: r.ok ? 'The script did not send back a link key. Update and redeploy the script.' : r.message });
      return;
    }
    // Only the returned token is kept; the PIN itself is never stored here.
    onUpdateSettings({ phoneToken: newToken, phoneLastError: undefined });
    setMode('none');
    setPin('');
    setPin2('');
    setCurrentPin('');
    setPinResult({ ok: true, message: 'PIN saved. Open the phone link and enter it once.' });
  };

  const saveEmail = async () => {
    const t = parseEmailTime(emailTime);
    const fixed = emailWhen === 'fixed';
    if (emailOn && fixed && !t) {
      setEmailResult({ ok: false, message: 'Enter a time such as 18:00.' });
      return;
    }
    if (emailOn && fixed && !emailTimeAllowed(emailTime)) {
      setEmailResult({ ok: false, message: 'Pick a time between 00:30 and 23:29.' });
      return;
    }
    const to = cleanRecipients(emailTo);
    if (to === null) {
      setEmailResult({ ok: false, message: 'Enter an email address, or several separated by commas (at most 5).' });
      return;
    }
    const time = t ?? parseEmailTime(DEFAULT_EMAIL_TIME)!;
    setEmailBusy('save');
    setEmailResult(null);
    // "When I clock out" needs no daily timer in the Sheet (the standup email is sent from the app); only a fixed time does.
    const r = await setEmailSchedule(url, token, { enabled: emailOn && fixed, hour: time.hour, minute: time.minute, tz: zone(), to });
    setEmailBusy(null);
    if (!r.ok) {
      setEmailResult({ ok: false, message: r.message });
      return;
    }
    const hhmm = `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
    onUpdateSettings({ emailEnabled: emailOn, emailTime: hhmm, emailWhen, emailTo: to || undefined });
    setEmailTo(to);
    setEmailResult({
      ok: true,
      message: !emailOn
        ? 'The daily email is off.'
        : fixed
          ? `The daily email is on. It arrives around ${hhmm} on days with a log or a clock-in.`
          : 'The daily email is on. It arrives a few minutes after you clock out. A day you forget is closed for you, and the email follows.',
    });
  };

  const testEmail = async () => {
    setEmailBusy('test');
    setEmailResult(null);
    const r = await sendTestEmail(url, token);
    setEmailBusy(null);
    const to = (r.data as { to?: unknown } | undefined)?.to;
    setEmailResult(
      r.ok ? { ok: true, message: typeof to === 'string' && to ? `Test email sent to ${to}.` : 'Test email sent.' } : { ok: false, message: r.message },
    );
  };

  if (urlUnsaved) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[length:var(--fs-body)] text-[var(--text-main)]">
          The Sheet URL above is not saved yet.{' '}
          {url ? 'This section is still using the URL you saved before.' : 'Save it, then this section can reach your script.'}
        </p>
        {onSaveAll && (
          <button type="button" onClick={onSaveAll} className={BTN}>
            Save settings now
          </button>
        )}
      </div>
    );
  }
  if (!url) {
    return <p className={HINT}>Connect the Google Sheet above and save, then come back here.</p>;
  }
  if (version === undefined) {
    return (
      <p role="status" className={`${HINT} flex items-center gap-1.5`}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking your script…
      </p>
    );
  }
  if (version === null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className={HINT}>Could not reach your script. Check the URL above with Test connection, then try again.</p>
        <button type="button" onClick={check} className={BTN}>
          Check again
        </button>
      </div>
    );
  }
  if (version < 3) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--fs-body)] text-[var(--text-main)]">
          Your Sheet runs script version {version}. Log sync still works; the phone page and the evening email need
          version 3, and the backup to the Sheet needs version 4.
        </p>
        <SetupSteps onCopy={copyScript} copied={copied} />
        <div>
          <button type="button" onClick={check} className={BTN}>
            Check again
          </button>
        </div>
      </div>
    );
  }

  const pinForm =
    mode === 'none' ? null : (
      <form onSubmit={submitPin} className="flex flex-col gap-3 w-full max-w-sm" aria-label={mode === 'reset' ? 'Reset phone access' : mode === 'change' ? 'Change PIN' : 'Set PIN'}>
        {mode === 'reset' && (
          <div>
            <label htmlFor={`${uid}-cur`} className={LABEL}>
              Current PIN
            </label>
            <input
              id={`${uid}-cur`}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))}
              className={`${FIELD} num !w-32`}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <div>
            <label htmlFor={`${uid}-pin`} className={LABEL}>
              New PIN
            </label>
            <input
              id={`${uid}-pin`}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              aria-describedby={`${uid}-pin-hint`}
              className={`${FIELD} num !w-32`}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-pin2`} className={LABEL}>
              New PIN again
            </label>
            <input
              id={`${uid}-pin2`}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={4}
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
              className={`${FIELD} num !w-32`}
            />
          </div>
        </div>
        <p id={`${uid}-pin-hint`} className={HINT}>
          4 digits. You type it on the phone; this computer does not keep it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pinBusy} className={`${BTN} v2-btn-strong`}>
            {pinBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            <span>{mode === 'reset' ? 'Reset access' : mode === 'change' ? 'Change PIN' : 'Set PIN'}</span>
          </button>
          <button type="button" onClick={() => openMode('none')} className={TEXT_BTN}>
            Cancel
          </button>
        </div>
      </form>
    );

  return (
    <>
      <div className="flex flex-col items-start gap-3">
        <h3 className={SUB}>Phone</h3>
        <p className={HINT}>
          Plan tasks on your phone on the way in; they wait here when you open WorkPulse. Use this on one computer only.
        </p>

        {/* Not a live region: background pushes would announce themselves every few minutes. */}
        <div className="flex flex-col gap-1 text-[length:var(--fs-small)]">
          <p className="text-[var(--text-main)]">
            <span className="font-semibold">{token ? 'Linked' : 'Not linked yet'}</span>
            <span className="text-[var(--text-muted)]">
              {' · '}script version <span className="num">{version}</span>
              {token &&
                (status.lastPushAt ? (
                  <>
                    {' · '}last sent from this computer <span className="num">{when(status.lastPushAt)}</span>
                  </>
                ) : (
                  ' · nothing sent yet'
                ))}
            </span>
          </p>
          {token && status.lastError && <p className="text-danger">The last try failed: {status.lastError}</p>}
          {token && status.deviceChanged && (
            <p className="text-danger">Another computer is also sending data to this Sheet. Only one computer should.</p>
          )}
        </div>

        {token && link && (
          <div className="w-full">
            <p id={`${uid}-link-label`} className={LABEL}>
              Phone link
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              {/* Wraps instead of scrolling, so the end of the link (?page=phone) always shows; a tap selects all of it. */}
              <p
                aria-labelledby={`${uid}-link-label`}
                className="v2-input flex-1 min-w-0 min-h-11 px-3 py-2.5 font-mono text-[length:var(--fs-body)] leading-snug break-all select-all"
              >
                {link}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
                <button type="button" onClick={copyLink} className={BTN}>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  <span>Copy link</span>
                </button>
                <a href={link} target="_blank" rel="noreferrer" className={`${BTN} no-underline`}>
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  <span>Open</span>
                </a>
              </div>
            </div>
            <p className={`${HINT} mt-1`}>Open it on your phone and add it to the home screen. Keep it private.</p>
          </div>
        )}

        {mode === 'none' &&
          (token ? (
            // -ml-1 cancels the buttons' own 4px padding, so the text lines up with the controls above.
            <div className="flex flex-wrap gap-x-4 -ml-1">
              <button type="button" onClick={() => openMode('change')} className={TEXT_BTN}>
                Change PIN
              </button>
              <button type="button" onClick={() => openMode('reset')} className={TEXT_BTN}>
                Reset phone access
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <button type="button" onClick={() => openMode('set')} className={`${BTN} v2-btn-strong`}>
                Set PIN
              </button>
              <button type="button" onClick={() => openMode('reset')} className={TEXT_BTN}>
                Already set a PIN? Reset phone access
              </button>
            </div>
          ))}
        {pinForm}
        <ResultLine result={pinResult} />

        <details className="w-full">
          <summary className="min-h-11 cursor-pointer list-none py-2 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 [&::-webkit-details-marker]:hidden">
            How to update the script
          </summary>
          <div className="pt-2">
            <SetupSteps onCopy={copyScript} copied={copied} />
          </div>
        </details>
      </div>

      <SheetBackupBlock
        url={url}
        token={token}
        version={version}
        backup={sheetBackup}
        setupSteps={<SetupSteps onCopy={copyScript} copied={copied} />}
      />

      <div className="flex flex-col items-start gap-3 border-t border-[var(--border-app)] pt-5">
        <h3 className={SUB}>Daily email</h3>
        {!token ? (
          <p className={HINT}>Set the phone PIN first; the email uses the same link to your Sheet.</p>
        ) : (
          <>
            <p className={HINT}>
              One email a day from your own Google account. Choose when it arrives: right after you clock out, or at a fixed
              time of day.
            </p>
            <label className="flex items-center gap-2.5 min-h-11 text-[length:var(--fs-body)] text-[var(--text-main)] cursor-pointer">
              <input
                type="checkbox"
                checked={emailOn}
                onChange={(e) => {
                  setEmailOn(e.target.checked);
                  setEmailResult(null);
                }}
                className="w-4 h-4 accent-[var(--accent-text)]"
              />
              <span className="font-semibold">Send me a daily email</span>
            </label>
            <fieldset disabled={!emailOn} className="flex w-full flex-col gap-2 border-0 p-0 disabled:opacity-60">
              <legend className={LABEL}>When it arrives</legend>
              <label className="flex items-start gap-2.5 min-h-11 text-[length:var(--fs-body)] text-[var(--text-main)] cursor-pointer">
                <input
                  type="radio"
                  name={`${uid}-when`}
                  checked={emailWhen === 'clockout'}
                  onChange={() => {
                    setEmailWhen('clockout');
                    setEmailResult(null);
                  }}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  <span className="font-semibold">When I clock out</span>
                  <span className="block text-[length:var(--fs-small)] text-[var(--text-muted)]">
                    The day&rsquo;s standup arrives a few minutes after you clock out. If you forget, WorkPulse clocks you out by
                    itself (when you have been idle for an hour after your hours are done, or just after midnight at the latest)
                    and sends it then.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 min-h-11 text-[length:var(--fs-body)] text-[var(--text-main)] cursor-pointer">
                <input
                  type="radio"
                  name={`${uid}-when`}
                  checked={emailWhen === 'fixed'}
                  onChange={() => {
                    setEmailWhen('fixed');
                    setEmailResult(null);
                  }}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  <span className="font-semibold">At a fixed time</span>
                  <span className="block text-[length:var(--fs-small)] text-[var(--text-muted)]">
                    A summary of the day (hours, logs by project, tasks done and still open) around the time you pick. Google sends it
                    within about 15 minutes of that time.
                  </span>
                </span>
              </label>
            </fieldset>
            <div className="w-full sm:max-w-md">
              <label htmlFor={`${uid}-to`} className={LABEL}>
                Send it to
              </label>
              <input
                id={`${uid}-to`}
                type="text"
                inputMode="email"
                autoComplete="off"
                placeholder="Your Google address (leave empty), or name@example.com"
                value={emailTo}
                onChange={(e) => {
                  setEmailTo(e.target.value);
                  setEmailResult(null);
                }}
                className={FIELD}
              />
              <p className="mt-1.5 text-[length:var(--fs-body)] text-[var(--text-main)]" data-testid="email-recipient">
                {settings.emailTo ? (
                  <>
                    Right now the email goes to <strong className="break-all">{settings.emailTo.split(',').join(', ')}</strong>.
                  </>
                ) : (
                  <>
                    Right now the email goes to <strong>the Google account that owns your Sheet script</strong>. Press Send a test
                    email to see which address that is.
                  </>
                )}
              </p>
              <p className={`${HINT} mt-1`}>
                To use another address: type it above (up to 5, separated by commas), then press <strong>Save email settings</strong>. To
                change it later, edit the box and save again. Empty the box and save to go back to your Google account. The sender is always
                the Google account that owns your Sheet script.
              </p>
              {version !== null && version !== undefined && version < 5 && (
                <p role="alert" className="mt-1 text-[length:var(--fs-small)] text-danger">
                  Your Sheet script is version {version}. Choosing an address needs version 5: re-paste the latest script and update your
                  existing deployment, or the box is ignored.
                </p>
              )}
            </div>
            {/* Phones: the time field and the two buttons stack at full width, like Test connection above. */}
            <div className="w-full flex flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-end">
              <div hidden={emailWhen !== 'fixed'}>
                <label htmlFor={`${uid}-time`} className={LABEL}>
                  Around
                </label>
                <input
                  id={`${uid}-time`}
                  type="time"
                  min="00:30"
                  max="23:29"
                  value={emailTime}
                  disabled={!emailOn}
                  onChange={(e) => {
                    setEmailTime(e.target.value);
                    setEmailResult(null);
                  }}
                  className={`${FIELD} num sm:!w-36 disabled:opacity-50`}
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
                {/* Outlined, and named for what it saves, so it is not taken for the sticky Save All Settings. */}
                <button type="button" onClick={saveEmail} disabled={emailBusy !== null} className={BTN}>
                  {emailBusy === 'save' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <span>Save email settings</span>
                </button>
                <button type="button" onClick={testEmail} disabled={emailBusy !== null} className={BTN}>
                  {emailBusy === 'test' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  <span>Send a test email</span>
                </button>
              </div>
            </div>
            <ResultLine result={emailResult} />
            <PermissionHelp open={!!emailResult && !emailResult.ok && /permission|daily timer|Google/i.test(emailResult.message)} onNotify={onNotify} />
          </>
        )}
      </div>
    </>
  );
};
