import { validate } from 'class-validator';
import { RunDemoOptimizationDto } from '../../src/trips/dto/run-demo-optimization.dto';

describe('RunDemoOptimizationDto validation', () => {
  it('chấp nhận DTO hợp lệ với caseId và ngân sách thời gian', async () => {
    const dto = Object.assign(new RunDemoOptimizationDto(), {
      caseId: 'novel_1_mekong_hub_spoke',
      timeBudgetSeconds: 1000,
      demoStackingEnabled: false,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('chấp nhận DTO hợp lệ với customRequest', async () => {
    const dto = Object.assign(new RunDemoOptimizationDto(), {
      customRequest: { job_id: 'custom-1', orders: [], vehicles: [] },
      timeBudgetSeconds: 10,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each([0, 1001])('từ chối thời gian tìm kiếm ngoài giới hạn 1-1000s: %s', async (val) => {
    const dto = Object.assign(new RunDemoOptimizationDto(), {
      caseId: 'scenario_1_multi_item',
      timeBudgetSeconds: val,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'timeBudgetSeconds')).toBe(true);
  });
});
