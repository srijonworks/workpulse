import { NET_MESSAGES, requestJson } from '../net/http';
import { ACTIVITY_SCAN_TIMEOUT_MS, AI_REQUEST_TIMEOUT_MS } from '../net/timeouts';
import type { ActivityItem, ScanRequest, ScanResponse, SuggestResponse } from './types';

// Every call has a time limit, and every failure reaches the caller as an Error with a plain sentence.
async function post<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const r = await requestJson<T>(url, { method: 'POST', body, timeoutMs });
  if (r.ok) return r.data;
  // The server's own sentence when it gave one; otherwise what went wrong with the request.
  throw new Error(r.kind === 'http' && r.message === NET_MESSAGES.http ? `Reading your activity failed (error ${r.status}).` : r.message);
}

/** Asks the local server to read this day's activity from the listed folders. */
export const scanActivityApi = (req: ScanRequest): Promise<ScanResponse> => post<ScanResponse>('/api/activity/scan', req, ACTIVITY_SCAN_TIMEOUT_MS);

/** The git projects in a folder (itself and the ones one level below), for automatic projects. */
export async function discoverReposApi(folder: string): Promise<string[]> {
  const r = await requestJson<{ repos: string[] }>('/api/activity/discover', { method: 'POST', body: { path: folder }, timeoutMs: 20_000 });
  return r.ok && Array.isArray(r.data.repos) ? r.data.repos : [];
}

/** Asks the server to group the items into tasks with Gemini. `tasks: null` means "use plain wording". */
export const suggestTasksApi = (args: {
  items: ActivityItem[];
  projectNameByFolder: Record<string, string>;
  customApiKey: string;
  provider: 'claude' | 'gemini';
}): Promise<SuggestResponse> => post<SuggestResponse>('/api/activity/suggest', args, AI_REQUEST_TIMEOUT_MS);
