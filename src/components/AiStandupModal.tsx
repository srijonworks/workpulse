import React, { useState, useEffect } from 'react';
import { Select } from './ui/Select';
import { ModalShell } from './ui/ModalShell';
import { plainAiMessage } from '../utils/aiErrors';
import { IconButton } from './ui/IconButton';
import { localDateStr } from '../utils/dates';
import { WorkLog, ReportFormat, ReportTone } from '../types';
import { generateAiReport, GenerateReportResult } from '../utils/aiGenerator';
import { aiWriterName } from '../utils/activity/settings';
import type { ActivityAi } from '../utils/activity/types';
import { modelLabel } from '../utils/geminiModels';
import {
  RefreshCw,
  Copy,
  ExternalLink,
  MessageSquare,
  X,
  Check,
  Send,
  Loader2,
  FileText,
} from 'lucide-react';

interface AiStandupModalProps {
  isOpen: boolean;
  onClose: () => void;
  logs: WorkLog[];
  selectedLogIds: string[];
  /** Who writes the text (the AI writer setting). */
  ai: ActivityAi;
  /** Only sent to the server when `ai` is 'gemini'. */
  geminiApiKey: string;
  defaultRecipientName?: string;
  defaultTone: ReportTone;
  onCopySuccess: () => void;
}

export const AiStandupModal: React.FC<AiStandupModalProps> = ({
  isOpen,
  onClose,
  logs,
  selectedLogIds,
  ai,
  geminiApiKey,
  defaultRecipientName,
  defaultTone,
  onCopySuccess,
}) => {
  const [format, setFormat] = useState<ReportFormat>('whatsapp');
  const [tone, setTone] = useState<ReportTone>(defaultTone || 'casual');
  const [recipientName, setRecipientName] = useState<string>(defaultRecipientName || '');
  const [generatedReport, setGeneratedReport] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationSource, setGenerationSource] = useState<GenerateReportResult['source'] | null>(null);
  const [aiModel, setAiModel] = useState<string | undefined>(undefined);
  const [aiError, setAiError] = useState<string | null>(null);

  // Active logs to include: if specific logs are selected, use them; otherwise use today's logs
  const todayStr = localDateStr();
  const activeLogs =
    selectedLogIds.length > 0
      ? logs.filter((l) => selectedLogIds.includes(l.id))
      : logs.filter((l) => l.date === todayStr);

  // Trigger initial generation when modal opens; clear everything when it closes so a reopened
  // modal never shows (and lets you copy) an earlier report.
  useEffect(() => {
    if (!isOpen) {
      setGeneratedReport('');
      setGenerationSource(null);
      setAiModel(undefined);
      setAiError(null);
      return;
    }
    if (activeLogs.length > 0) {
      handleGenerate();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    // Nothing to report: do not fall back to older logs, they would be sent as today's work.
    if (activeLogs.length === 0) {
      setGeneratedReport('');
      setGenerationSource(null);
      setAiError(null);
      return;
    }
    setIsGenerating(true);
    setAiError(null);
    try {
      const result = await generateAiReport({
        logs: activeLogs,
        format,
        tone,
        ai,
        customApiKey: geminiApiKey,
        recipientName: recipientName.trim() || undefined,
      });
      setGeneratedReport(result.text);
      setGenerationSource(result.source);
      setAiModel(result.model);
      setAiError(result.error ?? null);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyToClipboard = async () => {
    if (!generatedReport) return;
    try {
      await navigator.clipboard.writeText(generatedReport);
      onCopySuccess();
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  };

  const handleOpenWhatsApp = () => {
    if (!generatedReport) return;
    const encoded = encodeURIComponent(generatedReport);
    window.open(`https://web.whatsapp.com/send?text=${encoded}`, '_blank');
  };

  return (
    <ModalShell
      onClose={onClose}
      labelledBy="standup-title"
      backdropClassName="p-4 sm:p-6 overflow-y-auto"
      className="bg-[var(--bg-surface)] border border-[var(--border-app)] rounded-[var(--radius-card)] max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
    >
      <>
        
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[var(--border-app)]">
          <div className="flex items-center gap-2.5">
            <div>
              <h2 id="standup-title" className="text-base font-bold text-[var(--text-main)]">
                Draft standup
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                Turn {activeLogs.length} work log{activeLogs.length === 1 ? '' : 's'} into a message for your team. {ai === 'none' ? 'Written from a template; no AI is used.' : `Written by ${aiWriterName(ai)}, or a template if that is not available.`}
              </p>
            </div>
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Modal Controls Body */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto">
          
          {/* Format Selector Pills */}
          <div>
            <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
              Target Communication Channel:
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setFormat('whatsapp')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  format === 'whatsapp'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-main)] ring-1 ring-[var(--accent)]'
                    : 'border-[var(--border-control)] bg-[var(--bg-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)]'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs">
                  WhatsApp message
                </div>
                <p className="text-xs opacity-80 mt-1">Short bullets that read well on a phone.</p>
              </button>

              <button
                type="button"
                onClick={() => setFormat('slack')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  format === 'slack'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-main)] ring-1 ring-[var(--accent)]'
                    : 'border-[var(--border-control)] bg-[var(--bg-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)]'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs">
                  Slack or Teams
                </div>
                <p className="text-xs opacity-80 mt-1">Three parts: Done, In progress, Blockers.</p>
              </button>

              <button
                type="button"
                onClick={() => setFormat('executive')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  format === 'executive'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-main)] ring-1 ring-[var(--accent)]'
                    : 'border-[var(--border-control)] bg-[var(--bg-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)]'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs">
                  Executive memo
                </div>
                <p className="text-xs opacity-80 mt-1">A summary for leadership: impact and risks.</p>
              </button>
            </div>
          </div>

          {/* Tone Selector & Optional Recipient */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">
                Tone of Voice:
              </label>
              <Select
                ariaLabel="Tone of voice"
                value={tone}
                onChange={(v) => setTone(v as ReportTone)}
                options={[
                  { value: 'casual', label: 'Casual & Direct (Team standup)' },
                  { value: 'corporate', label: 'Formal Corporate (Management)' },
                  { value: 'bullet', label: 'Brief / Bullet-only (High velocity)' },
                  { value: 'client', label: 'Client-Facing (Deliverables focus)' },
                ]}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">
                Recipient Name / Title (Optional):
              </label>
              <input
                type="text"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                aria-label="Recipient name or title"
                placeholder="e.g. Sarah, Tech Lead, Team"
                className="w-full bg-[var(--bg-subtle)] border border-[var(--border-control)] rounded-md px-3 py-1.5 text-xs text-[var(--text-main)] focus:border-[var(--accent)]"
              />
            </div>
          </div>

          {/* Regenerate Button */}
          <div className="flex justify-end pt-1">
            <button
              onClick={handleGenerate}
              disabled={isGenerating || activeLogs.length === 0}
              className="px-3.5 py-1.5 rounded-md bg-[var(--bg-subtle)] hover:bg-[var(--border-app)] text-[var(--text-main)] text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-text)]" />
                  <span>Drafting with {aiWriterName(ai)}...</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5 text-[var(--accent-text)]" />
                  <span>Regenerate</span>
                </>
              )}
            </button>
          </div>

          {/* Generated Result Output Box */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span className="font-semibold">Generated Message Output (Editable):</span>
              {generationSource && (
                <span className="text-xs opacity-75">
                  Powered by {generationSource === 'gemini' ? modelLabel(aiModel) : generationSource === 'claude' ? 'Claude Code' : 'High-Fidelity Smart Template'}
                </span>
              )}
            </div>

            {activeLogs.length === 0 && (
              <div className="text-xs px-2.5 py-1.5 rounded-[var(--radius-btn)] border border-[var(--border-app)] bg-[var(--bg-subtle)] text-[var(--text-muted)]">
                No logs for today yet. Add a log, or select logs in the timeline, then reopen the standup.
              </div>
            )}
            {aiError && (
              <div className="text-xs px-2.5 py-1.5 rounded-[var(--radius-btn)] border border-warning/40 bg-warning/10 text-warning">
                {plainAiMessage(aiError)} This is the built-in template instead. Read it before you send it.
              </div>
            )}

            <textarea
              value={generatedReport}
              onChange={(e) => setGeneratedReport(e.target.value)}
              rows={9}
              className="w-full bg-[var(--bg-subtle)] border border-[var(--border-control)] rounded-md p-3 text-xs sm:text-sm text-[var(--text-main)] font-mono leading-relaxed focus:border-[var(--accent)] resize-y"
            />
          </div>

        </div>

        {/* Modal Footer Actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-t border-[var(--border-app)] bg-[var(--bg-subtle)]/50">
          <div className="text-xs text-[var(--text-muted)]">
            Ready to send to superiors or paste in standup channels.
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyToClipboard}
              disabled={!generatedReport}
              className="px-3.5 py-2 rounded-md bg-[var(--bg-surface)] border border-[var(--border-control)] hover:border-[var(--accent)] text-[var(--text-main)] text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy to Clipboard</span>
            </button>

            {format === 'whatsapp' && (
              <button
                onClick={handleOpenWhatsApp}
                disabled={!generatedReport}
                className="px-3.5 py-2 rounded-md bg-success-solid hover:bg-success-solid-hover text-white text-xs font-semibold shadow-xs transition-colors flex items-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open in WhatsApp Web</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="px-3 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)]"
            >
              Close
            </button>
          </div>
        </div>

      </>
    </ModalShell>
  );
};
