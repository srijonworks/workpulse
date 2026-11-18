import type { AppSettings } from '../types';

// When the daily email is sent. 'clockout': the day's standup, from the user's own Gmail through their Apps Script, right
// after the day closes (a manual clock-out, or the automatic one: a forgotten day is closed by the safety net, at the latest
// just after midnight). 'fixed': the evening summary at a set time of day (the Script's daily timer). Absent = 'fixed', which is
// how the app behaved before this choice existed.

export type EmailWhen = 'clockout' | 'fixed';

export const emailWhenOf = (s: Pick<AppSettings, 'emailWhen'>): EmailWhen => (s.emailWhen === 'clockout' ? 'clockout' : 'fixed');

/** Minutes the Sheet script waits before sending a closed day's standup. Nothing to wait for: the day is closed. */
export const CLOCKOUT_EMAIL_DELAY_MINUTES = 0;
