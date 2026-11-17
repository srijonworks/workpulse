// The browser-storage keys that hold the user's data. The copies on disk (src/server/localCopy.ts) hold exactly these,
// and nothing else: not the identity record, not the activity notice, not any device-only key.
export const DATA_KEYS = [
  'workpulse_logs',
  'workpulse_backlog',
  'workpulse_projects',
  'workpulse_tags',
  'workpulse_settings',
  'workpulse_workdays',
  'workpulse_standups',
] as const;

export type DataKey = (typeof DATA_KEYS)[number];

export const isDataKey = (k: string): k is DataKey => (DATA_KEYS as readonly string[]).includes(k);
