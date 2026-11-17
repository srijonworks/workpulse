import { DEFAULT_CLOCK_IN_MESSAGE, buildClockInMessage, clockInOpenPlan, parseChatTarget } from '../utils/clockInMessage';
import { Select } from './ui/Select';
import React, { createContext, useContext, useId, useRef, useState } from 'react';
import { localDateStr } from '../utils/dates';
import {
  Project,
  AppSettings,
  WorkLog,
  BacklogTask,
  ReportTone,
  BackupData,
  ToastMessage,
} from '../types';
import { parseBackup } from '../utils/backup';
import { ActivityFoldersSettings } from './activity/ActivityFoldersSettings';
import { ThemePicker } from './v2/settings/ThemePicker';
import { ProjectsSection, type ActionResult } from './v2/settings/ProjectsSection';
import { PhoneEmailSection } from './v2/settings/PhoneEmailSection';
import type { SheetBackupControls } from './v2/settings/SheetBackupBlock';
import type { PhoneSyncStatus } from '../hooks/usePhoneSync';
import { IconButton } from './ui/IconButton';
import { normalizeTheme, type ThemeId } from '../utils/theme';
import { activityFieldsFromSources, aiField, aiFromSettings, autoScanFromSettings, sourcesFromSettings } from '../utils/activity/settings';
import type { ActivityAi, ActivitySources } from '../utils/activity/types';
import { backupStatus, describeBackupAge } from '../utils/backupReminder';
import { findMisdatedLogs, DateFix } from '../utils/logDates';
import { UpdatesSection } from './v2/settings/UpdatesSection';
import { SystemStatusSection } from './v2/settings/SystemStatusSection';
import { buildSystemStatus, type StatusAction, type SystemStatusInput } from '../utils/systemStatus';
import { WidgetsSection } from './v2/settings/WidgetsSection';
import { logsToCsv } from '../utils/exportLogs';
import { GOOGLE_APPS_SCRIPT_CODE } from '../utils/googleAppsScriptTemplate';
import { testSheetConnection } from '../utils/sheetsSync';
import { Check, Copy, Loader2, Download, Upload, Eye, EyeOff, AlertCircle } from 'lucide-react';

interface SettingsViewProps {
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  /** Applies at once; the caller stores it. */
  onThemeChange: (theme: ThemeId) => void;
  projects: Project[];
  onUpdateProjects: (projects: Project[]) => void;
  tags: string[];
  onUpdateTags: (tags: string[]) => void;
  logs: WorkLog[];
  backlog: BacklogTask[];
  onResetSeedData: () => void;
  onImportBackup: (data: BackupData) => void;
  onBackupNow: () => void;
  /** Sends every log, old ones included, to the Google Sheet. */
  onSyncAllLogs: () => void;
  onFixLogDates: (fixes: DateFix[]) => void;
  onStartFresh: () => void;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info', action?: ToastMessage['action']) => void;
  /** The phone sync's state for the Phone & evening email section. */
  phoneStatus: PhoneSyncStatus;
  sheetBackup: SheetBackupControls;
  /** Saves only these fields at once, onto the newest settings (the Phone & evening email section). */
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  /** Creates or reuses the project named after the folder and links the folder, saved at once. */
  onAddProjectWithFolder: (input: { name?: string; color?: string; path?: string }) => ActionResult;
  onSetProjectFolder: (projectId: string, oldPath: string | undefined, newPath: string) => ActionResult;
  onRemoveProjectFolder: (path: string) => void;
  onTrashProject: (id: string) => void;
  onRestoreProject: (id: string) => void;
  onDeleteProjectForever: (id: string) => void;
  /** What the System status section shows (built here with buildSystemStatus). */
  systemInput: SystemStatusInput;
  /** A row's button: retry the saves, open a Settings section, or download a backup. */
  onSystemAction: (action: StatusAction) => void;
}

const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'office', label: 'Office day' },
  { id: 'widgets', label: 'Widgets' },
  { id: 'projects', label: 'Projects & tags' },
  { id: 'sheet', label: 'Google Sheet' },
  { id: 'phone', label: 'Phone & evening email' },
  { id: 'ai', label: 'AI' },
  { id: 'autoday', label: 'Automatic day' },
  { id: 'activity', label: 'Activity suggestions' },
  { id: 'data', label: 'Data & backup' },
  { id: 'updates', label: 'App updates' },
  { id: 'system', label: 'System status' },
  { id: 'sample', label: 'Sample data' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

const DEFAULT_WORKDAY_HOURS = 8;

const LABEL = 'block mb-1 text-[length:var(--fs-small)] font-semibold text-[var(--text-muted)]';
const FIELD = 'v2-input w-full h-11 px-3 text-[length:var(--fs-body)]';
const BTN =
  'v2-btn inline-flex items-center justify-center gap-1.5 min-h-11 px-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const DANGER_BTN =
  'inline-flex items-center justify-center min-h-11 px-4 rounded-[var(--radius-btn)] bg-danger-solid hover:bg-danger-solid-hover text-white text-[length:var(--fs-small)] font-semibold cursor-pointer';
const HINT = 'text-[length:var(--fs-small)] text-[var(--text-muted)]';

// Only the chosen section is shown; the others stay mounted (hidden) so typed values are kept.
const CurrentSection = createContext<SectionId>('appearance');

const Section: React.FC<{ id: SectionId; title: string; intro?: string; children: React.ReactNode }> = ({
  id,
  title,
  intro,
  children,
}) => {
  const current = useContext(CurrentSection);
  return (
    <section
      id={`settings-${id}`}
      aria-labelledby={`settings-${id}-h`}
      hidden={current !== id}
      className="scroll-mt-24"
    >
      <h2 id={`settings-${id}-h`} tabIndex={-1} className="v2-head">
        <span>{title}</span>
      </h2>
      <div className="flex flex-col gap-5">
        {intro && <p className={HINT}>{intro}</p>}
        {children}
      </div>
    </section>
  );
};

// One action in Data & backup or Sample data: what it does, then the button.
const Block: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col items-start gap-2 border-t border-[var(--border-app)] pt-5 first:border-t-0 first:pt-0">
    <h3 className="text-[length:var(--fs-body)] font-bold text-[var(--text-main)]">{title}</h3>
    {children}
  </div>
);

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onSaveSettings,
  onThemeChange,
  projects,
  onUpdateProjects,
  tags,
  onUpdateTags,
  logs,
  backlog,
  onResetSeedData,
  onImportBackup,
  onBackupNow,
  onSyncAllLogs,
  onFixLogDates,
  onStartFresh,
  onNotify,
  phoneStatus,
  sheetBackup,
  onUpdateSettings,
  onAddProjectWithFolder,
  onSetProjectFolder,
  onRemoveProjectFolder,
  onTrashProject,
  onRestoreProject,
  onDeleteProjectForever,
  systemInput,
  onSystemAction,
}) => {
  const uid = useId();
  const [current, setCurrent] = useState<SectionId>('appearance');
  const importRef = useRef<HTMLInputElement>(null);
  const hoursRef = useRef<HTMLInputElement>(null);

  // Office day state
  const [workdayHours, setWorkdayHours] = useState<string>(String(settings.workdayHours ?? DEFAULT_WORKDAY_HOURS));
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [clockMsgOn, setClockMsgOn] = useState(settings.clockInMessageEnabled === true);
  const [clockChat, setClockChat] = useState(settings.clockInChat ?? '');
  const [chatError, setChatError] = useState<string | null>(null);
  const [clockMsg, setClockMsg] = useState(settings.clockInMessage ?? DEFAULT_CLOCK_IN_MESSAGE);

  // Google Sheets state
  const [googleScriptUrl, setGoogleScriptUrl] = useState<string>(settings.googleScriptUrl || '');
  const [isTestingSheet, setIsTestingSheet] = useState<boolean>(false);
  const [sheetTestResult, setSheetTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // AI state
  const [geminiApiKey, setGeminiApiKey] = useState<string>(settings.geminiApiKey || '');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [defaultTone, setDefaultTone] = useState<ReportTone>(settings.defaultTone || 'casual');
  const [defaultRecipientName, setDefaultRecipientName] = useState<string>(settings.defaultRecipientName || '');

  // Activity suggestions state
  const [activitySources, setActivitySources] = useState<ActivitySources>(sourcesFromSettings(settings));
  const [activityAutoScan, setActivityAutoScan] = useState<boolean>(autoScanFromSettings(settings));
  // Automatic day: the start-of-day popup and clock-out safety net, projects made from folders, where to look, what to skip.
  const [autoDayOn, setAutoDayOn] = useState(settings.autoDayEnabled !== false);
  const [autoProjectsOn, setAutoProjectsOn] = useState(settings.activityAutoProjects !== false);
  const [watchFolder, setWatchFolder] = useState(settings.activityWatchFolder ?? '');
  const [unignored, setUnignored] = useState<string[]>([]);
  const [activityAi, setActivityAi] = useState<ActivityAi>(aiFromSettings(settings));

  const goTo = (id: SectionId) => {
    setCurrent(id);
    window.scrollTo({ top: 0 });
  };

  // Opens WhatsApp exactly as a clock-in would, with the values typed here (saved or not). Nothing is sent until you press Send there.
  const handleTestWhatsApp = () => {
    if (!parseChatTarget(clockChat)) {
      setChatError('Enter a phone number with the country code, a WhatsApp group invite link, or leave it empty.');
      return;
    }
    setChatError(null);
    const plan = clockInOpenPlan(clockChat, buildClockInMessage(clockMsg, new Date().toISOString()));
    if (plan.copy) void navigator.clipboard?.writeText(plan.copy).catch(() => {});
    window.open(plan.url, '_blank', 'noopener');
    onNotify(plan.copy ? 'WhatsApp opened and the message is copied: press Ctrl+V, then Enter.' : 'WhatsApp opened. Press Send there when you are ready.', 'info');
  };

  const handleSaveAll = () => {
    const hours = Number(workdayHours);
    if (!workdayHours.trim() || !Number.isFinite(hours) || hours < 1 || hours > 16) {
      setHoursError('Enter the hours in your workday as a number from 1 to 16.');
      hoursRef.current?.focus();
      return;
    }
    setHoursError(null);
    if (clockMsgOn && !parseChatTarget(clockChat)) {
      setChatError('Enter a phone number with the country code, a WhatsApp group invite link, or leave it empty.');
      return;
    }
    setChatError(null);
    const updated: AppSettings = {
      ...settings,
      workdayHours: hours,
      clockInMessageEnabled: clockMsgOn ? true : undefined,
      clockInChat: clockMsgOn && clockChat.trim() ? clockChat.trim() : undefined,
      clockInMessage: clockMsg.trim() && clockMsg.trim() !== DEFAULT_CLOCK_IN_MESSAGE ? clockMsg.trim() : undefined,
      googleScriptUrl: googleScriptUrl.trim(),
      geminiApiKey: geminiApiKey.trim(),
      defaultTone,
      defaultRecipientName: defaultRecipientName.trim() || undefined,
      ...activityFieldsFromSources(activitySources),
      activityAi: aiField(activityAi),
      activityAutoScan: activityAutoScan ? undefined : false,
      autoDayEnabled: autoDayOn ? undefined : false,
      activityAutoProjects: autoProjectsOn ? undefined : false,
      activityWatchFolder: watchFolder.trim() || undefined,
      // read from the live settings, so a folder ignored since this page opened (a project deleted for good) is kept
      activityIgnoredFolders: (settings.activityIgnoredFolders ?? []).filter((f) => !unignored.includes(f)).length > 0 ? (settings.activityIgnoredFolders ?? []).filter((f) => !unignored.includes(f)) : undefined,
    };
    onSaveSettings(updated);
    onNotify('All settings successfully saved!', 'success');
  };

  const handleTestSheet = async () => {
    if (!googleScriptUrl.trim()) {
      setSheetTestResult({
        success: false,
        message: 'Please enter a valid Google Apps Script Web App URL first.',
      });
      return;
    }
    setIsTestingSheet(true);
    setSheetTestResult(null);

    const result = await testSheetConnection(googleScriptUrl.trim());
    setIsTestingSheet(false);
    setSheetTestResult(result);
  };

  const handleCopyAppsScript = () => {
    navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_CODE);
    setCopiedCode(true);
    onNotify('Apps Script code copied to clipboard!', 'success');
    setTimeout(() => setCopiedCode(false), 2500);
  };

  const lastBackup = describeBackupAge(backupStatus(settings.lastBackupAt, logs, backlog).days);

  const misdatedLogs = React.useMemo(() => findMisdatedLogs(logs), [logs]);

  const handleFixDates = () => {
    const examples = misdatedLogs
      .slice(0, 5)
      .map((f) => `${f.from} -> ${f.to}: ${f.description.slice(0, 40)}`)
      .join('\n');
    if (
      window.confirm(
        `Move ${misdatedLogs.length} log(s) to the correct local date?\n\n${examples}${
          misdatedLogs.length > 5 ? '\n...' : ''
        }\n\nOnly the date changes. A backup file of your current data is downloaded first.`,
      )
    ) {
      onFixLogDates(misdatedLogs);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const result = parseBackup(await file.text());
    if (!result.ok) {
      onNotify(`Import failed: ${result.error}`, 'error');
      return;
    }
    const d = result.data;
    if (
      window.confirm(
        `Replace ALL current data with this backup?

${d.logs.length} logs, ${d.backlog.length} tasks, ${d.projects.length} projects, ${d.tags.length} tags.

Your current Gemini API key is kept. Export a backup first if you want to keep your current data.`,
      )
    ) {
      onImportBackup(d);
    }
  };

  // Export CSV
  const handleExportCSV = () => {
    const csv = logsToCsv(logs);

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workpulse-logs-${localDateStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    onNotify('Exported CSV spreadsheet', 'success');
  };

  return (
    <div className="mx-auto max-w-[1040px] px-4 sm:px-8 py-6 sm:py-7">
      <h1 className="sr-only">Settings</h1>
      <div className="grid gap-6 lg:gap-10 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0">
          <ul className="flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-24 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
            {SECTIONS.map((s) => (
              <li key={s.id} className="shrink-0">
                <a
                  href={`#settings-${s.id}`}
                  aria-current={current === s.id ? 'location' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    goTo(s.id);
                  }}
                  className={`block min-h-9 whitespace-nowrap rounded-[var(--radius-btn)] px-3 py-2 text-[length:var(--fs-small)] font-semibold ${
                    current === s.id
                      ? 'bg-[var(--bg-subtle)] text-[var(--text-main)]'
                      : 'text-[var(--text-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-main)]'
                  }`}
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <CurrentSection.Provider value={current}>
        <div className="flex min-w-0 max-w-[44rem] flex-col gap-10">
          <Section id="appearance" title="Appearance" intro="Pick how WorkPulse looks. It changes as soon as you choose.">
            <ThemePicker value={normalizeTheme(settings.theme)} onChange={onThemeChange} />
          </Section>

          <Section
            id="office"
            title="Office day"
            intro="How long your workday is. The clock at the top counts toward it, and History draws it as a target line."
          >
            <div>
              <label htmlFor={`${uid}-hours`} className={LABEL}>
                Hours in your workday
              </label>
              <input
                ref={hoursRef}
                id={`${uid}-hours`}
                type="number"
                inputMode="decimal"
                min={1}
                max={16}
                step={0.5}
                value={workdayHours}
                onChange={(e) => {
                  setWorkdayHours(e.target.value);
                  setHoursError(null);
                }}
                aria-invalid={hoursError ? true : undefined}
                aria-describedby={hoursError ? `${uid}-hours-err` : undefined}
                className={`${FIELD} num !w-28`}
              />
              {hoursError && (
                <p id={`${uid}-hours-err`} role="alert" className="mt-1 text-[length:var(--fs-small)] text-danger">
                  {hoursError}
                </p>
              )}
            </div>
            <div className="mt-5">
              <label className="flex items-center gap-2 text-[length:var(--fs-body)] font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  checked={clockMsgOn}
                  onChange={(e) => setClockMsgOn(e.target.checked)}
                  className="w-4 h-4 accent-[var(--accent-text)]"
                />
                Open WhatsApp with a message when I clock in
              </label>
              <p className="mt-1 text-[length:var(--fs-small)] text-[var(--text-muted)]">
                After your first clock-in of the day, WhatsApp Web opens in a new tab with the message typed in. You pick the group and press Send.
              </p>
              {clockMsgOn && (
                <div className="mt-3">
                  <label htmlFor={`${uid}-clockmsg`} className={LABEL}>
                    Message ({'{time}'} becomes your clock-in time)
                  </label>
                  <input id={`${uid}-clockmsg`} value={clockMsg} onChange={(e) => setClockMsg(e.target.value)} maxLength={500} className={FIELD} />
                  <label htmlFor={`${uid}-clockchat`} className={`${LABEL} mt-3`}>
                    Send to (optional)
                  </label>
                  <input
                    id={`${uid}-clockchat`}
                    value={clockChat}
                    onChange={(e) => {
                      setClockChat(e.target.value);
                      setChatError(null);
                    }}
                    placeholder="Phone number with country code, or a group invite link"
                    autoComplete="off"
                    aria-invalid={chatError ? true : undefined}
                    className={FIELD}
                  />
                  <p className="mt-1 text-[length:var(--fs-small)] text-[var(--text-muted)]">
                    A phone number opens that person's chat with the message typed in. A group invite link (chat.whatsapp.com/...)
                    opens the group and copies the message: press Ctrl+V, then Enter. Empty: you pick the chat in WhatsApp.
                  </p>
                  <button type="button" onClick={handleTestWhatsApp} className={`${BTN} mt-3`}>
                    Send a test message
                  </button>
                  {chatError && (
                    <p role="alert" className="mt-1 text-[length:var(--fs-small)] text-danger">
                      {chatError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </Section>

          <Section
            id="widgets"
            title="Widgets"
            intro="Small frameless windows that stay on your screen while you work. They follow your theme."
          >
            <WidgetsSection settings={settings} onUpdateSettings={onUpdateSettings} />
          </Section>

          <Section id="projects" title="Projects & tags">
            <ProjectsSection
              projects={projects}
              tags={tags}
              onUpdateProjects={onUpdateProjects}
              onUpdateTags={onUpdateTags}
              folders={settings.activityFolders ?? []}
              logs={logs}
              backlog={backlog}
              onAddProjectWithFolder={onAddProjectWithFolder}
              onSetProjectFolder={onSetProjectFolder}
              onRemoveProjectFolder={onRemoveProjectFolder}
              onTrashProject={onTrashProject}
              onRestoreProject={onRestoreProject}
              onDeleteProjectForever={onDeleteProjectForever}
            />
          </Section>

          <Section
            id="sheet"
            title="Google Sheet"
            intro="Send your logs to the shared Google Sheet your lead reads. Only new and edited logs are sent."
          >
            <div>
              <label htmlFor={`${uid}-sheet`} className={LABEL}>
                Google Apps Script web app URL
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id={`${uid}-sheet`}
                  type="url"
                  value={googleScriptUrl}
                  onChange={(e) => setGoogleScriptUrl(e.target.value)}
                  placeholder="https://script.google.com/macros/s/AKfycb.../exec"
                  autoComplete="off"
                  className={`${FIELD} flex-1 font-mono`}
                />
                <button
                  type="button"
                  onClick={handleTestSheet}
                  disabled={isTestingSheet || !googleScriptUrl.trim()}
                  className={`${BTN} shrink-0`}
                >
                  {isTestingSheet ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      <span>Testing…</span>
                    </>
                  ) : (
                    <span>Test connection</span>
                  )}
                </button>
              </div>
            </div>

            <div>
              <button type="button" onClick={onSyncAllLogs} disabled={!settings.googleScriptUrl} className={BTN}>
                Send all my logs to the Sheet
              </button>
              <p className="mt-1 text-[length:var(--fs-small)] text-[var(--text-muted)]">
                Connecting sends only logs made from now on. This sends every log you have, old ones too. A log already in the Sheet is
                updated, not added twice. Save your URL first.
              </p>
            </div>

            {sheetTestResult && (
              <div
                role="status"
                className={`rounded-[var(--radius-btn)] border p-3 text-[length:var(--fs-small)] ${
                  sheetTestResult.success
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-danger/30 bg-danger/10 text-danger'
                }`}
              >
                <p className="flex items-center gap-1.5 font-bold">
                  {sheetTestResult.success ? (
                    <>
                      <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>Connection verified</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>Connection error</span>
                    </>
                  )}
                </p>
                <p className="mt-0.5">{sheetTestResult.message}</p>
              </div>
            )}

            <details className="group">
              <summary className="min-h-11 cursor-pointer list-none py-2 text-[length:var(--fs-small)] font-semibold text-[var(--accent-text)] underline underline-offset-4 [&::-webkit-details-marker]:hidden">
                Set up the sheet: Apps Script code
              </summary>
              <div className="flex flex-col gap-3 pt-2">
                <p className={HINT}>
                  Open your Google Sheet, go to <strong>Extensions &gt; Apps Script</strong>, paste the code below and
                  deploy it as a Web App with access set to <em>Anyone</em>.
                </p>
                <div>
                  <button type="button" onClick={handleCopyAppsScript} className={BTN}>
                    {copiedCode ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                    <span>{copiedCode ? 'Copied' : 'Copy code'}</span>
                  </button>
                </div>
                <pre
                  tabIndex={0}
                  aria-label="Apps Script code"
                  className="max-h-56 overflow-auto rounded-[var(--radius-btn)] border border-[var(--border-app)] bg-[var(--bg-subtle)] p-3 text-[length:var(--fs-small)] text-[var(--text-main)] [font-family:var(--font-mono)]"
                >
                  {GOOGLE_APPS_SCRIPT_CODE}
                </pre>
              </div>
            </details>
          </Section>

          <Section id="phone" title="Phone & evening email">
            <PhoneEmailSection settings={settings} onUpdateSettings={onUpdateSettings} status={phoneStatus} sheetBackup={sheetBackup} onNotify={onNotify} urlUnsaved={googleScriptUrl.trim() !== (settings.googleScriptUrl || '')} onSaveAll={handleSaveAll} />
          </Section>

          <Section
            id="ai"
            title="AI"
            intro="Who writes your standups, end-of-day logs and suggested logs, plus the default tone and who the standup is addressed to."
          >
            <fieldset className="space-y-3">
              <legend className={LABEL}>AI writer</legend>
              {(
                [
                  ['claude', 'Claude on this computer (recommended)', 'Uses the Claude login already on this computer. No API key. Takes about 5 seconds. Your log text goes to Claude.'],
                  ['gemini', 'Gemini key', 'Uses your own Gemini API key. Your log text goes to Google.'],
                  ['none', 'None', 'Template text built on this computer. Nothing is sent anywhere.'],
                ] as const
              ).map(([value, title, hint]) => (
                <label key={value} className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
                  <input
                    type="radio"
                    name={`${uid}-ai-writer`}
                    checked={activityAi === value}
                    onChange={() => setActivityAi(value)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-semibold">{title}</span>
                    <span className="block text-[var(--text-muted)]">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {activityAi === 'gemini' && (
            <div>
              <label htmlFor={`${uid}-key`} className={LABEL}>
                Gemini API key
              </label>
              <div className="flex items-center gap-1">
                <input
                  id={`${uid}-key`}
                  type={showApiKey ? 'text' : 'password'}
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                  placeholder="AIzaSy… (leave blank to use the server's key)"
                  autoComplete="off"
                  className={`${FIELD} flex-1 font-mono`}
                />
                <IconButton
                  label={showApiKey ? 'Hide key' : 'Show key'}
                  aria-pressed={showApiKey}
                  onClick={() => setShowApiKey((s) => !s)}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </IconButton>
              </div>
              <p className={`${HINT} mt-1`}>
                Kept in this browser only and never written into backups. If blank, WorkPulse uses the key set on the server.
              </p>
            </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={`${uid}-tone`} className={LABEL}>
                  Default tone
                </label>
                <Select
                  id={`${uid}-tone`}
                  value={defaultTone}
                  onChange={(v) => setDefaultTone(v as ReportTone)}
                  options={[
                    { value: 'casual', label: 'Casual and direct (agile standup)' },
                    { value: 'corporate', label: 'Formal corporate (stakeholders)' },
                    { value: 'bullet', label: 'Brief, bullets only' },
                    { value: 'client', label: 'Client-facing (deliverables)' },
                  ]}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-to`} className={LABEL}>
                  Default recipient
                </label>
                <input
                  id={`${uid}-to`}
                  type="text"
                  value={defaultRecipientName}
                  onChange={(e) => setDefaultRecipientName(e.target.value)}
                  placeholder="e.g. Alex, Tech Lead"
                  autoComplete="off"
                  className={FIELD}
                />
              </div>
            </div>
          </Section>

          <Section
            id="autoday"
            title="Automatic day"
            intro="WorkPulse can start and close your day for you. Everything it adds can be undone, and logs you write by hand are never touched."
          >
            <div className="space-y-5">
              <label className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
                <input type="checkbox" checked={autoDayOn} onChange={(e) => setAutoDayOn(e.target.checked)} className="mt-0.5" />
                <span>
                  <span className="font-semibold">Start and close the day automatically</span>
                  <span className="block text-[var(--text-muted)]">
                    Asks you to clock in when you start working (it confirms itself after 10 minutes if you are at the PC), closes a day you forgot at the
                    last time the PC was in use, and adds the day&apos;s logs, standup and email after you clock out. Turn it off to do all of this yourself.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-[length:var(--fs-small)] text-[var(--text-main)] cursor-pointer">
                <input type="checkbox" checked={autoProjectsOn} onChange={(e) => setAutoProjectsOn(e.target.checked)} className="mt-0.5" />
                <span>
                  <span className="font-semibold">Create projects from my folders</span>
                  <span className="block text-[var(--text-muted)]">
                    A folder in your projects folder becomes a project once you have worked in it (a commit, a changed document or a few AI prompts).
                  </span>
                </span>
              </label>
              <div>
                <label htmlFor="watch-folder" className={LABEL}>
                  Projects folder
                </label>
                <input
                  id="watch-folder"
                  value={watchFolder}
                  onChange={(e) => setWatchFolder(e.target.value)}
                  placeholder="Automatic, from the folders you linked"
                  spellCheck={false}
                  autoComplete="off"
                  className={FIELD}
                />
                <p className={HINT}>The folder that holds your projects, like E:\Projects. Leave it empty to use the parent of the folders you linked.</p>
              </div>
              {(settings.activityIgnoredFolders ?? []).filter((f) => !unignored.includes(f)).length > 0 && (
                <div>
                  <h4 className="text-[length:var(--fs-small)] font-semibold text-[var(--text-main)]">Folders skipped</h4>
                  <ul className="mt-1 space-y-1">
                    {(settings.activityIgnoredFolders ?? [])
                      .filter((f) => !unignored.includes(f))
                      .map((f) => (
                        <li key={f} className="flex flex-wrap items-center gap-x-3 text-[length:var(--fs-small)] text-[var(--text-main)]">
                          <span className="min-w-0 truncate font-mono" title={f}>{f}</span>
                          <button type="button" onClick={() => setUnignored((u) => [...u, f])} className="underline underline-offset-2 text-[var(--accent-text)] cursor-pointer">
                            Stop skipping
                          </button>
                        </li>
                      ))}
                  </ul>
                  <p className={HINT}>Press Save settings to apply.</p>
                </div>
              )}
            </div>
          </Section>

          <Section
            id="activity"
            title="Activity suggestions"
            intro="At the end of the day WorkPulse can suggest logs from your work. Only the folders linked to your projects are read."
          >
            <ActivityFoldersSettings
              folders={settings.activityFolders ?? []}
              sources={activitySources}
              projects={projects}
              onSourcesChange={setActivitySources}
              autoScan={activityAutoScan}
              onAutoScanChange={setActivityAutoScan}
            />
          </Section>

          <Section
            id="data"
            title="Data & backup"
            intro="Your data lives only in this browser. Back it up, or take a timesheet out as a spreadsheet."
          >
            <Block title="JSON backup">
              <p className={HINT}>
                Contains all work logs, tasks, projects, tags and settings, never your Gemini API key. Importing replaces
                all current data.
              </p>
              <p className="text-[length:var(--fs-small)] font-semibold text-[var(--text-main)]" data-testid="last-backup">
                {lastBackup}
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={onBackupNow} className={BTN}>
                  <Download className="h-4 w-4" aria-hidden="true" />
                  <span>Download JSON backup</span>
                </button>
                <button type="button" onClick={() => importRef.current?.click()} className={BTN}>
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  <span>Import JSON backup</span>
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={handleImportFile}
                />
              </div>
            </Block>

            <Block title="CSV spreadsheet">
              <p className={HINT}>Opens in Excel, Google Sheets or Numbers.</p>
              <button type="button" onClick={handleExportCSV} className={BTN}>
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>Download CSV logs</span>
              </button>
            </Block>

            {misdatedLogs.length > 0 && (
              <Block title={`Fix log dates (${misdatedLogs.length})`}>
                <p className={HINT}>
                  {misdatedLogs.length} log(s) made between 00:00 and 06:00 local time were filed under the previous day
                  (older versions used the UTC date). Move them to the day you actually worked. Nothing changes until you
                  confirm.
                </p>
                <button type="button" onClick={handleFixDates} className={BTN}>
                  Review and fix dates
                </button>
              </Block>
            )}
          </Section>

          <Section id="updates" title="App updates" intro="Check for a newer version of the WorkPulse desktop app and install it. Your data stays as it is.">
            <UpdatesSection />
          </Section>

          <Section id="system" title="System status" intro="Whether WorkPulse is saving, copying and syncing, in plain words.">
            <SystemStatusSection status={buildSystemStatus(systemInput)} nowMs={systemInput.now} onAction={onSystemAction} onNotify={onNotify} />
          </Section>

          <Section
            id="sample"
            title="Sample data"
            intro="The demo logs, tasks and projects WorkPulse starts with. Both actions download a backup file first."
          >
            <Block title="Start fresh">
              <p className={HINT}>
                Remove the demo logs, tasks and projects and start with an empty workspace and one &ldquo;General&rdquo;
                project. Settings stay.
              </p>
              <button type="button" onClick={onStartFresh} className={DANGER_BTN}>
                Start with empty data
              </button>
            </Block>

            <Block title="Reset to demo data">
              <p className={HINT}>Replaces logs, tasks, projects and tags with the demo data.</p>
              <button type="button" onClick={onResetSeedData} className={DANGER_BTN}>
                Reset to demo data
              </button>
            </Block>
          </Section>

          <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 sm:bottom-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[var(--radius-card)] border border-[var(--border-control)] bg-[var(--bg-surface-elevated)] px-4 py-3">
              <p className={HINT}>Theme, projects and tags apply as you change them. The rest waits for Save.</p>
              <button type="button" onClick={handleSaveAll} className={`${BTN} v2-btn-strong`}>
                <Check className="h-4 w-4" aria-hidden="true" />
                <span>Save All Settings</span>
              </button>
            </div>
          </div>
        </div>
        </CurrentSection.Provider>
      </div>
    </div>
  );
};
