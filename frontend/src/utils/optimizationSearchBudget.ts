export type SearchBudgetPreset = 5 | 30 | 120 | 'CUSTOM';

export const MIN_SEARCH_BUDGET_SECONDS = 1;
export const MAX_SEARCH_BUDGET_SECONDS = 120;
export const DEFAULT_SEARCH_BUDGET_SECONDS = 30;

export const resolveSearchBudgetSeconds = (
  preset: SearchBudgetPreset,
  customSeconds: number,
): number => {
  const requested = preset === 'CUSTOM' ? customSeconds : preset;
  return Math.min(
    MAX_SEARCH_BUDGET_SECONDS,
    Math.max(MIN_SEARCH_BUDGET_SECONDS, Math.round(requested)),
  );
};

export const presetForSearchBudget = (
  seconds: number,
): SearchBudgetPreset => {
  if (seconds === 5 || seconds === 30 || seconds === 120) return seconds;
  return 'CUSTOM';
};

export const getSearchBudgetDescription = (seconds: number): string => {
  if (seconds <= 5) {
    return `Tối đa ${seconds} giây mỗi lượt · ưu tiên có phương án nhanh.`;
  }
  if (seconds <= 30) {
    return `Tối đa ${seconds} giây mỗi lượt · cân bằng tốc độ và chất lượng phương án.`;
  }
  return `Tối đa ${seconds} giây mỗi lượt · tìm kỹ hơn, không đảm bảo tối ưu toàn cục.`;
};
