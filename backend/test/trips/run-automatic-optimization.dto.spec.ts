import { validate } from 'class-validator';
import { RunAutomaticOptimizationDto } from '../../src/trips/dto/run-automatic-optimization.dto';

const dtoWithBudget = (searchBudgetSeconds: number) =>
  Object.assign(new RunAutomaticOptimizationDto(), {
    idempotencyKey: '835b88fb-78df-4b9a-9f92-e7bcd1de1784',
    searchBudgetSeconds,
  });

describe('RunAutomaticOptimizationDto search budget', () => {
  it('accepts an integer budget within the optimizer contract', async () => {
    await expect(validate(dtoWithBudget(30))).resolves.toHaveLength(0);
  });

  it.each([0, 121, 2.5])('rejects an invalid budget: %s', async (value) => {
    const errors = await validate(dtoWithBudget(value));
    expect(errors.some((error) => error.property === 'searchBudgetSeconds')).toBe(true);
  });
});
