import { describe, expect, it } from 'vitest';
import { CLOCKOUT_EMAIL_DELAY_MINUTES, emailWhenOf } from './emailWhen';

describe('emailWhenOf', () => {
  it('is fixed unless clock-out was chosen, and ignores unknown values', () => {
    expect(emailWhenOf({})).toBe('fixed');
    expect(emailWhenOf({ emailWhen: 'fixed' })).toBe('fixed');
    expect(emailWhenOf({ emailWhen: 'clockout' })).toBe('clockout');
    expect(emailWhenOf({ emailWhen: 'later' as never })).toBe('fixed');
  });
  it('sends a closed day at once', () => {
    expect(CLOCKOUT_EMAIL_DELAY_MINUTES).toBe(0);
  });
});
