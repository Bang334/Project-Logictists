import { describe, it, expect } from 'vitest';
import { formatCurrency, formatDecimal } from '../utils/format';

describe('format utilities', () => {
  it('formats decimals correctly with 2 decimal places by default', () => {
    expect(formatDecimal(4060.317599999999)).toBe('4060.32');
    expect(formatDecimal(6424.900000000001)).toBe('6424.90');
    expect(formatDecimal(13)).toBe('13.00');
    expect(formatDecimal(0)).toBe('0.00');
    expect(formatDecimal(null)).toBe('0');
    expect(formatDecimal(undefined)).toBe('0');
  });

  it('formats decimals with custom digit count', () => {
    expect(formatDecimal(4060.317599999999, 1)).toBe('4060.3');
    expect(formatDecimal(4060.317599999999, 0)).toBe('4060');
  });

  it('formats currency with VND format', () => {
    const formatted = formatCurrency(29050470);
    expect(formatted).toContain('29.050.470');
    expect(formatted).toContain('₫');
  });
});
