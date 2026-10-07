import { describe, expect, it } from 'vitest';
import {
  getSearchBudgetDescription,
  resolveSearchBudgetSeconds,
} from '../utils/optimizationSearchBudget';

describe('optimizationSearchBudget', () => {
  it('uses preset budgets directly', () => {
    expect(resolveSearchBudgetSeconds(5, 60)).toBe(5);
    expect(resolveSearchBudgetSeconds(30, 60)).toBe(30);
    expect(resolveSearchBudgetSeconds(120, 60)).toBe(120);
  });

  it('uses and clamps a custom budget to the optimizer contract', () => {
    expect(resolveSearchBudgetSeconds('CUSTOM', 45)).toBe(45);
    expect(resolveSearchBudgetSeconds('CUSTOM', 0)).toBe(1);
    expect(resolveSearchBudgetSeconds('CUSTOM', 999)).toBe(120);
  });

  it('explains that the budget applies per search and is not an optimality guarantee', () => {
    expect(getSearchBudgetDescription(120)).toContain('mỗi lượt');
    expect(getSearchBudgetDescription(120)).toContain('không đảm bảo tối ưu toàn cục');
  });
});
