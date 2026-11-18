import { describe, expect, it } from 'vitest';
import { splitBold } from './boldMarks';

describe('splitBold', () => {
  it('makes starred text bold and keeps the rest plain', () => {
    expect(splitBold('• *hims:* Code fixes')).toEqual([
      { text: '• ', bold: false },
      { text: 'hims:', bold: true },
      { text: ' Code fixes', bold: false },
    ]);
  });

  it('handles a whole bold line and several marks', () => {
    expect(splitBold('*What I completed today:*')).toEqual([{ text: 'What I completed today:', bold: true }]);
    expect(splitBold('*a* and *b*').map((p) => p.bold)).toEqual([true, false, true]);
  });

  it('leaves lone stars and empty marks alone', () => {
    expect(splitBold('5 * 3 = 15')).toEqual([{ text: '5 * 3 = 15', bold: false }]);
    expect(splitBold('** nothing')).toEqual([{ text: '** nothing', bold: false }]);
    expect(splitBold('')).toEqual([]);
  });

  it('never joins marks across lines', () => {
    expect(splitBold('*one\ntwo*')).toEqual([{ text: '*one\ntwo*', bold: false }]);
  });
});
