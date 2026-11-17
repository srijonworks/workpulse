import type { ActivityAi, ActivityFolder } from './utils/activity/types';

export type TaskStatus = 'completed' | 'in_progress' | 'blocked';

export interface WorkLog {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (24-hour)
  projectId: string;
  projectName: string;
  description: string;
  status: TaskStatus;
  tags: string[];
  linkUrl?: string;
  imageBase64?: string;
  durationMinutes?: number;
  energyRating?: number; // 1 to 5
  createdAt: string;
  // When this log was confirmed written to the Google Sheet (undefined = not synced yet).
  syncedAt?: string;
  // When the user last edited this log; a log edited after its last sync needs sending again.
  editedAt?: string;
  isSynthesized?: boolean;
  // 'auto' = written by the day-close job from the day's activity (shown with an Auto badge; manual logs have none).
  origin?: 'auto';
  // Activity item ids this log was suggested from; they are not suggested again. Never sent to the Sheet.
  sourceIds?: string[];
  underlyingTasks?: {
    id: string;
    title: string;
    stage: TaskStage;
    elapsedSeconds: number;
  }[];
}

export type TaskStage = 'planned' | 'in_progress' | 'paused' | 'blocked' | 'done';

export interface BacklogTask {
  id: string;
  title: string;
  projectId: string;
  dueDate: string; // YYYY-MM-DD
  completed: boolean;
  stage?: TaskStage;
  originalDate: string; // Date when first created
  isRolledOver: boolean;
  startedAt?: string;
  completedAt?: string;
  blockReason?: string;
  elapsedSeconds?: number;
  isRunning?: boolean;
  isSynthesized?: boolean;
  synthesizedAt?: string;
  // Seconds of this task's tracked time already written into a log (undefined = nothing yet).
  loggedSeconds?: number;
  // Seconds added (or taken away, negative) by hand with "Adjust time": a timer started late, or a total corrected. Shown on the row.
  adjustedSeconds?: number;
  // Each stretch the timer ran (ISO UTC). The last one is open (no `end`) while the task runs.
  segments?: { start: string; end?: string }[];
  // True when the task was added from the phone page (it arrived through the Sheet inbox).
  fromPhone?: boolean;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  isArchived: boolean;
  /** ISO time the project was moved to the Trash (Settings > Projects & tags). Absent: not in the Trash. */
  trashedAt?: string;
}

// The three themes. Older stored ids (modern, compact, minimalist, matrix) are mapped by normalizeTheme.
export type ThemeId = 'chase' | 'timecard' | 'console';

export type ReportFormat = 'whatsapp' | 'slack' | 'executive';

export type ReportTone = 'casual' | 'corporate' | 'bullet' | 'client';

export type ColorMode = 'light' | 'dark';

export type AppNavTab = 'today' | 'tasks' | 'history' | 'settings';

/** One desktop widget: shown or not, and whether it stays on top of other windows (absent = on top). */
export interface WidgetPrefs {
  on: boolean;
  top?: boolean;
}
export interface WidgetsSettings {
  time?: WidgetPrefs;
  tasks?: WidgetPrefs;
}

export interface AppSettings {
  theme: ThemeId;
  // No longer used (the theme decides light or dark); kept so stored data round-trips.
  colorMode?: ColorMode;
  googleScriptUrl: string;
  geminiApiKey: string;
  defaultTone: ReportTone;
  defaultRecipientName?: string;
  lastDismissedReminderDate?: string;
  // Logs created before this moment are assumed to be handled already and are never auto-sent.
  syncTrackingSince?: string;
  // No longer used (the Matrix theme is gone); kept so stored data round-trips.
  crtEffect?: boolean;
  // When a backup file was last downloaded from Settings or the reminder (ISO). Absent means never.
  // Device-specific: not written into backup files and not replaced by an import.
  lastBackupAt?: string;
  // Folders scanned for activity suggestions, each linked to a project. Device-specific: not in backups.
  activityFolders?: ActivityFolder[];
  // Activity sources. Claude Code prompts and git commits are both on unless set to false.
  activityUseClaude?: boolean;
  // Look for new activity every 5 minutes while Today or End my day is open. Absent = on; false = off.
  activityAutoScan?: boolean;
  activityUseGit?: boolean;
  // OpenCode and Codex CLI prompts: on unless set to false.
  activityUseOpenCode?: boolean;
  activityUseCodex?: boolean;
  // Document files worked on (names and times only): on unless set to false.
  activityUseDocs?: boolean;
  // Projects are created from the folders you work in. Absent = on.
  activityAutoProjects?: boolean;
  // The start-of-day popup and the automatic clock-out safety net. Absent = on; false = off.
  autoDayEnabled?: boolean;
  // The folder that holds your projects. Absent: the common parent of the linked folders.
  activityWatchFolder?: string;
  // Folders the automatic projects skip (a project deleted for good adds its folder here).
  activityIgnoredFolders?: string[];
  // Which AI groups the activity into suggestions. Absent = Claude Code.
  activityAi?: ActivityAi;
  // The project last used when a task or log was submitted from Today's inputs or Plan your day. Absent = first active project.
  lastProjectId?: string;
  // Length of the workday in hours, for the office clock. Absent = 8.
  workdayHours?: number;
  // Open WhatsApp Web with a typed "arrived at office" message after the first clock-in of a day. Absent = off; true = on.
  clockInMessageEnabled?: boolean;
  // The message; {time} is the clock-in time. Absent or empty = "I've arrived at office at {time}".
  clockInMessage?: string;
  // The chat for it: a phone number, or a WhatsApp group invite link. Absent = pick the chat in WhatsApp.
  clockInChat?: string;
  // Phone page link. The token, last sync time, device id and last error belong to this device:
  // none of them is written into backup files or replaced by an import.
  phoneToken?: string;
  phoneSyncAt?: string; // ISO
  phoneDeviceId?: string;
  phoneLastError?: string;
  // Last full copy of the data to the Sheet (ISO) and why the last try failed. Device-only, like the phone fields.
  sheetBackupAt?: string;
  sheetBackupError?: string;
  // Desktop widgets (Electron app only). Device-only: never in backups, never replaced by an import. Absent = both off.
  widgets?: WidgetsSettings;
  // Evening email from the Apps Script. emailTime is "HH:MM" local time; absent = 18:00.
  emailEnabled?: boolean;
  emailTime?: string;
  // Who the evening email goes to (comma-separated, up to 5). Absent = the Google account that owns the script.
  emailTo?: string;
}

// One day at the office. ISO timestamps (UTC).
export interface WorkdayRecord {
  clockIn: string;
  clockOut?: string;
}

// Keyed by the local YYYY-MM-DD of clockIn.
export type Workdays = Record<string, WorkdayRecord>;

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
  action?: { label: string; onClick: () => void };
  /** How long it stays before going away on its own. Hovering or focusing it pauses the clock. */
  durationMs?: number;
}

export interface BackupData {
  logs: WorkLog[];
  backlog: BacklogTask[];
  projects: Project[];
  tags: string[];
  settings: AppSettings;
  // Absent in backups made before the office clock existed.
  workdays?: Workdays;
  // Absent in backups made before saved standups existed (an import then leaves the stored ones alone).
  standups?: StandupRecord[];
}

/** A standup kept after it was written: one per closed day, one per week (Friday to Thursday). */
export interface StandupRecord {
  id: string; // 'day:<YYYY-MM-DD>' or 'week:<YYYY-MM-DD of the Thursday>'
  kind: 'day' | 'week';
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  text: string;
  writer: 'claude' | 'gemini' | 'template';
  // Plain sentence: why the preferred writer was not used.
  notice?: string;
  createdAt: string;
  // Set when the user edited the text; the app never overwrites an edited standup.
  editedAt?: string;
  syncedAt?: string;
}
