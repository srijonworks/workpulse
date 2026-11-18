import { WorkLog, ReportFormat, ReportTone } from '../types';
import { plainAiMessage } from './aiErrors';
import { requestJson } from './net/http';
import { AI_REQUEST_TIMEOUT_MS } from './net/timeouts';
import type { ActivityAi } from './activity/types';

export interface ReportPeriod {
  from: string;
  to: string;
  label: string;
}

export interface GenerateReportParams {
  logs: WorkLog[];
  format: ReportFormat;
  tone: ReportTone;
  /** Who writes the text (the "AI writer" setting). Claude on this computer unless said otherwise. */
  ai?: ActivityAi;
  /** Only sent to the server when `ai` is 'gemini'. */
  customApiKey?: string;
  recipientName?: string;
  /** The days the report covers. Without it the report is for today. */
  period?: ReportPeriod;
  /** Extra background for the prompt (dates, earlier daily standups), already redacted and capped. */
  context?: string;
  /** For tests. */
  fetchFn?: typeof fetch;
}

export interface GenerateReportResult {
  text: string;
  source: 'claude' | 'gemini' | 'template';
  model?: string; // model that wrote the text (source 'gemini')
  error?: string; // why the AI was not used (source 'template')
}

/** The request body for /api/gemini/generate. The Gemini key goes along only when Gemini is the writer. */
export function standupRequestBody(
  ai: 'claude' | 'gemini',
  prompt: string,
  systemInstruction: string,
  customApiKey?: string,
) {
  return {
    prompt,
    systemInstruction,
    provider: ai,
    customApiKey: ai === 'gemini' ? customApiKey || undefined : undefined,
  };
}

export async function generateAiReport(params: GenerateReportParams): Promise<GenerateReportResult> {
  const { logs, format, tone, customApiKey, recipientName, ai = 'claude', fetchFn = fetch, period, context } = params;

  if (logs.length === 0) {
    return {
      text: 'No logs selected. Please select at least one task or log entry to generate a report.',
      source: 'template',
    };
  }

  // Build structured data context
  const completed = logs.filter((l) => l.status === 'completed');
  const inProgress = logs.filter((l) => l.status === 'in_progress');
  const blocked = logs.filter((l) => l.status === 'blocked');

  const logsSummary = logs
    .map((l, i) => {
      const duration = l.durationMinutes ? ` (${l.durationMinutes}m)` : '';
      const tags = l.tags.length ? ` [${l.tags.join(' ')}]` : '';
      const link = l.linkUrl ? ` - Link: ${l.linkUrl}` : '';
      return `${i + 1}. [${l.status.toUpperCase()}] [Project: ${l.projectName}] ${l.description}${duration}${tags}${link}`;
    })
    .join('\n');

  const systemInstruction = `You are an elite executive productivity assistant for high-performing software engineers and team leads.
Your job is to transform raw task logs into concise, beautifully formatted, human-ready updates without robotic filler or marketing jargon.
Follow the exact requested format, tone, and audience constraints faithfully.`;

  const formatDescription =
    format === 'whatsapp'
      ? `A concise, polite WhatsApp message for a direct manager or lead. Use WhatsApp markdown (*bold*, _italic_). Keep it professional, mobile-friendly and scannable. Use no emoji, or at most one where it truly helps.`
      : format === 'slack'
      ? `A clean, professional Slack/Teams standup update with exactly three sections. Use plain bold headings with no emoji. Under each heading write short bullets, one per piece of work, starting with the project name in bold (for example "- *project:* what was done"). No filler and no exclamation marks. The sections are:
*What I completed today:*
*In progress / Rolling over:*
*Blockers / Waiting on:*`
      : `An Executive Summary Memo for leadership, directors, or clients. Grouped by project impact, key deliverables, and risks. Polished corporate tone.`;

  const prompt = `Please generate a work report based on these logged tasks:

--- LOGGED WORK ENTRIES ---
${logsSummary}
---------------------------

${period ? `Covers: ${period.label} (${period.from === period.to ? period.from : `${period.from} to ${period.to}`})
` : ''}${context ? `
Background:
${context}
` : ''}
Target Format: ${formatDescription}
Tone: ${tone} (e.g. casual & direct, formal corporate, brief bullet-only, or client-facing)
${recipientName ? `Addressed to: ${recipientName}` : ''}

Generate the final message text now. Do not wrap in markdown code fence unless code is included. Output directly.`;

  // "No AI": the template only, and nothing leaves the browser.
  if (ai === 'none') {
    return { text: generateFallbackTemplate(logs, format, tone, recipientName, period?.label), source: 'template' };
  }

  // The request has a time limit and never throws: a server that is down or too slow gives the plain-sentence template below.
  let error: string | undefined;
  const r = await requestJson<{ text?: unknown; modelUsed?: string; error?: string; notice?: string }>('/api/gemini/generate', {
    method: 'POST',
    body: standupRequestBody(ai, prompt, systemInstruction, customApiKey),
    timeoutMs: AI_REQUEST_TIMEOUT_MS,
    fetchFn,
  });
  const data = (r.ok ? r.data : r.data && typeof r.data === 'object' ? r.data : {}) as { text?: unknown; modelUsed?: string; error?: string; notice?: string };
  if (r.ok && typeof data.text === 'string' && data.text.trim()) {
    return { text: data.text.trim(), source: ai, model: data.modelUsed };
  }
  error = plainAiMessage(data.error || data.notice || (r.ok ? 'The AI did not answer.' : r.message));

  // High-fidelity fallback template generator
  return {
    text: generateFallbackTemplate(logs, format, tone, recipientName, period?.label),
    source: 'template',
    error,
  };
}

export function generateFallbackTemplate(
  logs: WorkLog[],
  format: ReportFormat,
  tone: ReportTone,
  recipientName?: string,
  periodLabel?: string,
): string {
  const completed = logs.filter((l) => l.status === 'completed');
  const inProgress = logs.filter((l) => l.status === 'in_progress');
  const blocked = logs.filter((l) => l.status === 'blocked');
  const todayStr =
    periodLabel ??
    new Date().toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

  const greeting = recipientName
    ? tone === 'casual'
      ? `Hi ${recipientName},`
      : `Dear ${recipientName},`
    : tone === 'casual'
    ? 'Hey team,'
    : 'Hello,';

  if (format === 'whatsapp') {
    let out = `${greeting} quick progress update for *${todayStr}*:\n\n`;

    if (completed.length > 0) {
      out += `*Done Today*\n`;
      completed.forEach((l) => {
        out += `• *[${l.projectName}]* ${l.description}\n`;
      });
      out += '\n';
    }

    if (inProgress.length > 0) {
      out += `*In Progress*\n`;
      inProgress.forEach((l) => {
        out += `• *[${l.projectName}]* ${l.description}\n`;
      });
      out += '\n';
    }

    if (blocked.length > 0) {
      out += `*Blockers / Waiting On*\n`;
      blocked.forEach((l) => {
        out += `• *[${l.projectName}]* ${l.description}\n`;
      });
      out += '\n';
    }

    out += `Let me know if you need anything clarified!`;
    return out;
  }

  if (format === 'slack') {
    let out = `*Daily Standup — ${todayStr}*\n\n`;

    out += `*What I completed today:*\n`;
    if (completed.length > 0) {
      completed.forEach((l) => {
        const link = l.linkUrl ? ` (<${l.linkUrl}|Link>)` : '';
        out += `• [${l.projectName}] ${l.description}${link}\n`;
      });
    } else {
      out += `• None completed today\n`;
    }
    out += '\n';

    out += `*In progress / Rolling over:*\n`;
    if (inProgress.length > 0) {
      inProgress.forEach((l) => {
        out += `• [${l.projectName}] ${l.description}\n`;
      });
    } else {
      out += `• No ongoing tasks in flight\n`;
    }
    out += '\n';

    out += `*Blockers / Waiting on:*\n`;
    if (blocked.length > 0) {
      blocked.forEach((l) => {
        out += `• [${l.projectName}] ${l.description}\n`;
      });
    } else {
      out += `• None, clear path forward\n`;
    }

    return out;
  }

  // Executive format
  let memo = `MEMORANDUM: Daily Work & Milestone Progress\n`;
  memo += `DATE: ${todayStr}\n`;
  memo += `PREPARED FOR: ${recipientName || 'Engineering & Product Leadership'}\n`;
  memo += `STATUS: ${blocked.length > 0 ? 'Requires Attention' : 'On Track'}\n\n`;

  memo += `1. EXECUTIVE HIGHLIGHTS\n`;
  if (completed.length > 0) {
    completed.forEach((l) => {
      memo += `  - ${l.projectName}: ${l.description}\n`;
    });
  } else {
    memo += `  - Active research and development in progress.\n`;
  }
  memo += `\n`;

  memo += `2. WORK IN FLIGHT & NEXT STEPS\n`;
  if (inProgress.length > 0) {
    inProgress.forEach((l) => {
      memo += `  - ${l.projectName}: ${l.description}\n`;
    });
  } else {
    memo += `  - All queued items for this cycle completed.\n`;
  }
  memo += `\n`;

  if (blocked.length > 0) {
    memo += `3. CRITICAL BLOCKERS & RISKS\n`;
    blocked.forEach((l) => {
      memo += `  - [ACTION NEEDED] ${l.projectName}: ${l.description}\n`;
    });
  } else {
    memo += `3. RISKS & DEPENDENCIES\n`;
    memo += `  - No critical risks identified at this time.\n`;
  }

  return memo;
}
