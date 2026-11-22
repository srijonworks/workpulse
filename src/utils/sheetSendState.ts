// After a clock-out the Sheet sends the day's email from what this computer pushed, so the clock band says whether the
// Sheet has it: 'sent' (safe to shut down), 'sending' (a push is due or on its way), 'failed' (the last push failed; keep the
// PC on, it tries again). null: nothing to say (not clocked out, or no Sheet linked).

export type SheetSendState = 'sent' | 'sending' | 'failed';

export function sheetSendState(i: { linked: boolean; clockedOut: boolean; pending: boolean; pushFailed: boolean }): SheetSendState | null {
  if (!i.linked || !i.clockedOut) return null;
  if (!i.pending) return 'sent';
  return i.pushFailed ? 'failed' : 'sending';
}
