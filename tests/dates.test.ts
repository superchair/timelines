import { describe, expect, it } from 'vitest';
import { addDays, addMonths, diffDays, isIsoDate, startOfWeek, toIsoDate } from '../shared/dates';

describe('dates', () => {
  it('validates calendar dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-2-3')).toBe(false);
  });
  it('does day arithmetic across DST and month ends', () => {
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(diffDays('2027-01-01', '2026-12-25')).toBe(7);
  });
  it('adds months to month starts', () => {
    expect(addMonths('2026-11-01', 2)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
  });
  it('finds Monday week starts', () => {
    expect(startOfWeek('2026-10-20')).toBe('2026-10-19'); // Tuesday -> Monday
    expect(startOfWeek('2026-10-25')).toBe('2026-10-19'); // Sunday -> Monday
  });
  it('converts sprint timestamps to dates', () => {
    expect(toIsoDate('2026-10-19T13:00:00.000Z')).toBe('2026-10-19');
    expect(toIsoDate(null)).toBeUndefined();
  });
});
