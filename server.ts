import express from 'express';
import { localDateStr } from './src/utils/dates';
import http from 'http';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { isAllowedScriptUrl } from './src/utils/scriptUrl';
import { GEMINI_MODEL_CASCADE, GEMINI_TIMEOUT_MS } from './src/utils/geminiModels';
import { buildBuckets, buildEodPrompt, mergeSynthesis, templateLog } from './src/utils/eodSynthesis';
import { isAllowedHostHeader, isAllowedOrigin } from './src/utils/hostCheck';
import { activityGuard } from './src/server/activityGuard';
import { describeRouteError, installProcessGuards, jsonErrorHandler, listenErrorMessage } from './src/server/errors';
import { forwardToScript } from './src/server/scriptProxy';
import { backupsDir, dataDir, logsDir } from './src/server/dataDir';
import { createLocalCopy } from './src/server/localCopy';
import { cleanClientEntries, createLogBudget } from './src/server/clientLog';
import { createFileLog } from './src/shell/fileLog';
import { CLAUDE_MODEL_LABEL, claudeWriterGuard, eodViaClaude, standupViaClaude, writerFromRequest } from './src/server/aiWriter';
import { createFolderPicker, isAllowedPickOrigin } from './src/server/folderPicker';
import { findRepos, scanActivity } from './src/server/activityReaders';
import { ACTIVITY_SOURCE_IDS } from './src/utils/activity/registry';
import { ACTIVITY_TASKS_SCHEMA, buildActivityPrompt, parseAiTasks } from './src/utils/activity/aiTasks';
import { runClaudeJson } from './src/server/claudeCli';
import { clip, redactSecrets } from './src/utils/activity/sanitize';
import type { ActivityItem, ScanRequest } from './src/utils/activity/types';

// Load .env.local first (local overrides), then fall back to .env
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The SDK reports API errors as a JSON string; show just the human-readable message.
function readableError(raw: unknown): string {
  const text = typeof raw === 'string' && raw ? raw : 'error';
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? m[1] : text;
}

// Tries each model in order. Every request is cancelled (AbortSignal) after GEMINI_TIMEOUT_MS,
// so a hung model cannot stall the route. Returns the first non-empty answer, or all the errors.
async function generateWithCascade(
  ai: GoogleGenAI,
  contents: string,
  config: Record<string, unknown>,
): Promise<{ text: string; model: string; errors: string[] }> {
  const errors: string[] = [];
  for (const model of GEMINI_MODEL_CASCADE) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: { ...config, abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) },
      });
      const text = response.text || '';
      if (text.trim()) return { text, model, errors };
      errors.push(`${model}: empty response`);
    } catch (err: any) {
      const message = readableError(err?.message);
      console.warn(`Gemini model ${model} failed (${message}), trying the next one...`);
      errors.push(`${model}: ${message}`);
      // A rejected key will be rejected by every model: stop instead of repeating the failure.
      if (/api key|permission|unauthori[sz]ed|forbidden/i.test(message)) break;
    }
  }
  return { text: '', model: '', errors };
}

const shortReason = (errors: string[]) => (errors[0] || 'unknown error').slice(0, 200);

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3737;
  // Localhost only by default. Set HOST=0.0.0.0 to allow other devices on your network (no authentication!).
  const HOST = process.env.HOST || '127.0.0.1';

  // DNS-rebinding guard (S3): while bound to localhost, /api only answers requests addressed to a
  // local hostname. With HOST set to something else the user opted in to LAN access, so skip it.
  const extraHosts = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  if (HOST === '127.0.0.1') {
    app.use('/api', (req, res, next) => {
      if (!isAllowedHostHeader(req.headers.host, extraHosts) || !isAllowedOrigin(req.headers.origin, extraHosts)) {
        return res.status(403).json({ error: 'Forbidden: unexpected Host or Origin.' });
      }
      next();
    });
  }

  app.use(express.json({ limit: '30mb' }));

  // Standup text. Claude Code on this computer writes it by default (provider 'claude', local setup only);
  // provider 'gemini' uses the Gemini key. The path keeps its old name.
  app.post('/api/gemini/generate', claudeWriterGuard(HOST, PORT), async (req, res) => {
    try {
      const { prompt, systemInstruction, customApiKey, provider } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
      }

      if (writerFromRequest(provider) === 'claude') {
        const run = await standupViaClaude(runClaudeJson, prompt, typeof systemInstruction === 'string' ? systemInstruction : '');
        if (!run.ok) {
          console.warn('Standup: Claude Code failed:', run.reason);
          return res.json({ text: '', notice: `${run.reason} Showing the offline template instead.` });
        }
        return res.json({ text: run.text, modelUsed: CLAUDE_MODEL_LABEL });
      }

      const activeApiKey = customApiKey?.trim() || process.env.GEMINI_API_KEY;

      if (!activeApiKey) {
        return res.status(400).json({
          error: 'No Gemini API key provided. Please configure your key in Settings or set GEMINI_API_KEY.',
          needsKey: true,
        });
      }

      const ai = new GoogleGenAI({
        apiKey: activeApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const result = await generateWithCascade(
        ai,
        prompt,
        systemInstruction ? { systemInstruction, temperature: 0.7 } : {},
      );
      if (!result.text) {
        console.error('Gemini standup failed on every model:', result.errors);
        return res.status(502).json({
          error: `AI request failed: ${shortReason(result.errors)}`,
          details: result.errors,
        });
      }
      return res.json({ text: result.text, modelUsed: result.model });
    } catch (err: any) {
      console.error('Gemini API Error:', err);
      const message = err?.message || 'Failed to generate content with Gemini';
      return res.status(500).json({ error: message });
    }
  });

  // End-of-Day (EOD) AI Log Synthesizer endpoint
  app.post('/api/synthesize-eod', claudeWriterGuard(HOST, PORT), async (req, res) => {
    try {
      const { tasks = [], projects = [], date = localDateStr(), customApiKey, provider } = req.body;

      if (!Array.isArray(tasks) || tasks.length === 0) {
        return res.json({ synthesizedLogs: [] });
      }

      const splitBuckets = buildBuckets(tasks, Array.isArray(projects) ? projects.filter((p: any) => p && p.id) : []);
      if (splitBuckets.length === 0) {
        return res.json({ synthesizedLogs: [] });
      }

      const templates = () => splitBuckets.map(templateLog);

      if (writerFromRequest(provider) === 'claude') {
        const run = await eodViaClaude(runClaudeJson, splitBuckets, date);
        if (!run.ok) {
          console.warn('End of day: Claude Code failed:', run.reason);
          return res.json({
            synthesizedLogs: templates(),
            isAIGenerated: false,
            apiError: run.reason,
            notice: `${run.reason} Showing template text instead.`,
          });
        }
        const aiCount = run.logs.length - run.fallbackSplitIds.length;
        return res.json({
          synthesizedLogs: run.logs,
          isAIGenerated: aiCount > 0,
          modelUsed: CLAUDE_MODEL_LABEL,
          fallbackSplitIds: run.fallbackSplitIds,
          notice:
            run.fallbackSplitIds.length > 0
              ? `The AI wrote ${aiCount} of ${run.logs.length} groups. The other ${run.fallbackSplitIds.length} use template text: check them before pushing.`
              : undefined,
        });
      }

      const activeApiKey = customApiKey?.trim() || process.env.GEMINI_API_KEY;

      if (!activeApiKey) {
        return res.json({
          synthesizedLogs: templates(),
          isAIGenerated: false,
          apiKeyMissing: true,
          notice: 'No Gemini API key: using template text. Add your key in Settings for AI synthesis.',
        });
      }

      const ai = new GoogleGenAI({
        apiKey: activeApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const { systemInstruction, userPrompt } = buildEodPrompt(date, splitBuckets);

      const result = await generateWithCascade(ai, userPrompt, {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.3,
      });

      if (!result.text) {
        console.warn('All Gemini models failed, using templates:', result.errors);
        return res.json({
          synthesizedLogs: templates(),
          isAIGenerated: false,
          apiError: result.errors.join('; '),
          notice: `AI request failed (${shortReason(result.errors)}). Showing template text instead.`,
        });
      }

      let aiItems: unknown[] = [];
      try {
        const parsed = JSON.parse(result.text);
        aiItems = Array.isArray(parsed?.synthesized) ? parsed.synthesized : [];
      } catch (parseErr: any) {
        console.error('Failed to parse Gemini JSON output:', parseErr, result.text);
        return res.json({
          synthesizedLogs: templates(),
          isAIGenerated: false,
          apiError: 'Failed to parse AI output',
          notice: 'The AI returned an unreadable answer. Showing template text instead.',
        });
      }

      const { logs, fallbackSplitIds } = mergeSynthesis(splitBuckets, aiItems);
      const aiCount = logs.length - fallbackSplitIds.length;
      return res.json({
        synthesizedLogs: logs,
        isAIGenerated: aiCount > 0,
        modelUsed: result.model,
        fallbackSplitIds,
        notice:
          fallbackSplitIds.length > 0
            ? `The AI wrote ${aiCount} of ${logs.length} groups. The other ${fallbackSplitIds.length} use template text: check them before pushing.`
            : undefined,
      });
    } catch (err: any) {
      console.error('EOD Synthesis API Error:', err);
      return res.status(500).json({ error: err?.message || 'Failed to synthesize EOD logs' });
    }
  });

  // Activity suggestions. Both routes read or describe files on this computer, so they sit behind
  // activityGuard (loopback bind + strict Host header).
  app.post('/api/activity/scan', activityGuard(HOST, PORT), async (req, res) => {
    const body = req.body as Partial<ScanRequest> | undefined;
    if (!body || typeof body.date !== 'string' || !Array.isArray(body.folders) || typeof body.sources !== 'object' || body.sources === null) {
      return res.status(400).json({ error: 'The activity request was incomplete.' });
    }
    try {
      const result = await scanActivity({
        date: body.date,
        folders: body.folders,
        sources: Object.fromEntries(ACTIVITY_SOURCE_IDS.map((id) => [id, (body.sources as Record<string, unknown>)[id] === true])),
      });
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Could not read your activity.' });
    }
  });

  // "Add project from folder": opens the folder dialog on this computer (Windows only). One at a time;
  // the dialog is closed when the browser goes away. Same guard as the activity routes, plus an Origin check.
  const folderPicker = createFolderPicker();
  app.post('/api/pick-folder', activityGuard(HOST, PORT), async (req, res) => {
    if (!isAllowedPickOrigin(req.headers.origin, PORT)) {
      return res.status(403).json({ error: 'The folder window only opens for this app, on this computer.' });
    }
    const call = folderPicker.pick();
    res.on('close', () => {
      if (!res.writableEnded) call.cancel();
    });
    const { status, body } = await call.result;
    if (res.writableEnded || res.destroyed) return;
    return res.status(status).json(body);
  });

  app.post('/api/activity/discover', activityGuard(HOST, PORT), async (req, res) => {
    const p = req.body?.path;
    if (typeof p !== 'string' || !path.isAbsolute(p)) return res.status(400).json({ error: 'Enter the full folder path.' });
    try {
      return res.json({ repos: (await findRepos([p])).slice(0, 100) });
    } catch (err) {
      return res.status(500).json({ error: describeRouteError(err) });
    }
  });

  app.post('/api/activity/suggest', activityGuard(HOST, PORT), async (req, res) => {
    try {
      const { items: rawItems, projectNameByFolder = {}, customApiKey, provider: rawProvider } = req.body ?? {};
      // Claude Code (the user's own login on this computer) is the default; Gemini only when asked for.
      const provider: 'claude' | 'gemini' = rawProvider === 'gemini' ? 'gemini' : 'claude';
      // Whatever the client sends is re-sanitised here: this is the last stop before Gemini.
      const items: ActivityItem[] = (Array.isArray(rawItems) ? rawItems : [])
        .filter(
          (i: any) =>
            i && typeof i.id === 'string' && typeof i.folder === 'string' && typeof i.time === 'string' &&
            typeof i.text === 'string' && (i.source === 'git' || i.source === 'claude' || i.source === 'task'),
        )
        .map((i: any) => ({ id: i.id, source: i.source, folder: i.folder, time: i.time, text: clip(redactSecrets(i.text), 200) }));
      if (items.length === 0) return res.json({ tasks: [] });

      const names: Record<string, string> =
        projectNameByFolder && typeof projectNameByFolder === 'object' ? projectNameByFolder : {};
      const { systemInstruction, userPrompt, shortToId } = buildActivityPrompt(items, names);

      if (provider === 'claude') {
        const run = await runClaudeJson({ prompt: `${systemInstruction}

${userPrompt}`, schema: ACTIVITY_TASKS_SCHEMA });
        if (!run.ok) {
          console.warn('Activity suggestions: Claude Code failed:', run.reason);
          return res.json({ tasks: null, notice: `${run.reason} Showing plain wording instead.` });
        }
        return res.json({ tasks: parseAiTasks(run.data, shortToId, items), modelUsed: 'Claude Code' });
      }

      const activeApiKey = (typeof customApiKey === 'string' ? customApiKey.trim() : '') || process.env.GEMINI_API_KEY;
      if (!activeApiKey) {
        return res.json({
          tasks: null,
          apiKeyMissing: true,
          notice: 'No Gemini key: using plain wording. Add your key in Settings for AI wording.',
        });
      }
      const ai = new GoogleGenAI({ apiKey: activeApiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } });
      const result = await generateWithCascade(ai, userPrompt, {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.3,
      });

      if (!result.text) {
        console.warn('Activity suggestions: all Gemini models failed:', result.errors);
        return res.json({ tasks: null, notice: `AI request failed (${shortReason(result.errors)}). Showing plain wording instead.` });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        return res.json({ tasks: null, notice: 'The AI returned an unreadable answer. Showing plain wording instead.' });
      }
      return res.json({ tasks: parseAiTasks(parsed, shortToId, items), modelUsed: result.model });
    } catch (err: any) {
      console.error('Activity suggest error:', err);
      return res.status(500).json({ error: err?.message || 'Failed to group your activity.' });
    }
  });

  // The log file (~/WorkPulse/logs): what happened and where, never what the user wrote. The page cannot write files, so
  // it sends its errors here. Same guard as the routes that touch this computer's files, plus the Origin check.
  const dataFolder = dataDir();
  const serverLog = createFileLog({ dir: logsDir(dataFolder), name: `server-${PORT}` });
  serverLog.info('server', `Started on port ${PORT}`);
  const logBudget = createLogBudget();
  app.post('/api/client-log', activityGuard(HOST, PORT), (req, res) => {
    if (!isAllowedPickOrigin(req.headers.origin, PORT)) {
      return res.status(403).json({ error: 'The log only takes entries from this app, on this computer.' });
    }
    const entries = cleanClientEntries(req.body);
    const allowed = logBudget.take(entries.length);
    for (const e of entries.slice(0, allowed)) serverLog[e.level](e.area, e.message, e.detail);
    return res.json({ ok: true, accepted: allowed });
  });

  // Copies of the user's data on this computer (~/WorkPulse/backups): what the app restores from when the browser's
  // storage is wiped or damaged. Same guard as the routes that touch local files, plus the Origin check; the copy belongs
  // to the address the page was loaded from (data belongs to an origin).
  const localCopy = createLocalCopy(backupsDir(dataFolder));
  const copyGuard = activityGuard(HOST, PORT);
  const copyOrigin = (req: express.Request, res: express.Response): string | null => {
    if (!isAllowedPickOrigin(req.headers.origin, PORT)) {
      res.status(403).json({ error: 'Copies are only kept for this app, on this computer.' });
      return null;
    }
    return String(req.headers.host || `localhost:${PORT}`);
  };
  app.get('/api/disk-copy', copyGuard, async (req, res) => {
    const origin = copyOrigin(req, res);
    if (!origin) return;
    const r = await localCopy.read(origin);
    if (r.damaged) serverLog.warn('disk-copy', 'A copy file failed its checksum');
    return res.json({ copy: r.copy, damaged: r.damaged });
  });
  app.put('/api/disk-copy', copyGuard, async (req, res) => {
    const origin = copyOrigin(req, res);
    if (!origin) return;
    const b = req.body ?? {};
    const r = await localCopy.write(origin, { profileId: String(b.profileId ?? ''), rev: Number(b.rev), keys: b.keys, takeover: b.takeover === true });
    if (r.ok) return res.json(r);
    if (r.code === 'disk') serverLog.error('disk-copy', r.message);
    return res.status(r.code === 'invalid' ? 400 : r.code === 'disk' ? 500 : 409).json(r);
  });
  app.post('/api/disk-copy/safety', copyGuard, async (req, res) => {
    const origin = copyOrigin(req, res);
    if (!origin) return;
    const b = req.body ?? {};
    const r = await localCopy.safety(origin, b.keys, String(b.reason ?? 'copy'), typeof b.profileId === 'string' ? b.profileId : undefined);
    if (!r.ok && r.code === 'disk') serverLog.error('disk-copy', r.message);
    return res.status(r.ok ? 200 : r.code === 'invalid' ? 400 : 500).json(r);
  });

  // Google Apps Script Proxy to circumvent browser CORS / redirect issues. The call itself (time limit, plain
  // sentences for every failure) is in src/server/scriptProxy.ts.
  app.post('/api/sheets/proxy', async (req, res) => {
    const { scriptUrl, payload, action, method } = req.body ?? {};
    if (!scriptUrl) {
      return res.status(400).json({ error: 'Google Apps Script URL is required' });
    }
    if (!isAllowedScriptUrl(String(scriptUrl))) {
      return res.status(400).json({
        error: 'Only Google Apps Script URLs (https://script.google.com/macros/s/...) are allowed',
      });
    }
    const answer = await forwardToScript({ scriptUrl: String(scriptUrl), action, method, payload });
    return res.status(answer.status).json(answer.body);
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      hasEnvGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      time: new Date().toISOString(),
    });
  });

  // Vite middleware in dev or static files in prod
  const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
  if (!isProd) {
    // Imported only here, so the packaged desktop app (production) does not need Vite.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      // Share the app's HTTP server for HMR so no extra port (24678) is needed
      // forwardConsole off: Vite would print every browser console error (with its stack) into this process's output.
      server: { middlewareMode: true, ws: { server: httpServer }, forwardConsole: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // WORKPULSE_DIST: the desktop app keeps the built page next to its own files.
    const distDir = process.env.WORKPULSE_DIST || path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Last of all: anything a route lets escape (an oversized or malformed body, a bug) is answered as JSON with a
  // plain sentence, never as an HTML error page.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (describeRouteError(err).status >= 500) serverLog.error('route', `${req.method} ${req.path} failed`, err);
    jsonErrorHandler(err, req, res, next);
  });

  // Inside the desktop app the shell shows the reason in its own dialog (and exiting here would close the app
  // with no message), so the error is passed on there.
  const insideDesktopApp = process.env.WORKPULSE_DESKTOP === '1';
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    console.error(listenErrorMessage(err, PORT));
    if (insideDesktopApp) throw err;
    process.exit(1);
  });
  if (!insideDesktopApp) installProcessGuards();

  httpServer.listen(PORT, HOST, () => {
    console.log(`WorkPulse Server running on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  // Inside the desktop app, exiting would close it without a word; the shell reports that the server did not start.
  if (process.env.WORKPULSE_DESKTOP !== '1') process.exit(1);
});
