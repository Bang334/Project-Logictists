/**
 * Utility functions for formatting numbers, currency, and quantities across UI components.
 */

export const formatCurrency = (val: number): string =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(val);

export const formatDecimal = (val: number | null | undefined, digits: number = 2): string => {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '0';
  return Number(val).toFixed(digits);
};
