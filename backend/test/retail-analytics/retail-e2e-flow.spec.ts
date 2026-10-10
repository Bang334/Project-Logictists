import { readFileSync } from 'fs';
import { join } from 'path';

describe('Merged retail and TMS database contract', () => {
  it('giữ 66 model retail và bổ sung 20 model TMS/auth/lịch sử đã duyệt', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    for (const model of ['AuthSession', 'AuthLoginLimit', 'Allocation', 'Package', 'OrderStop', 'UserRoleScope', 'UserLocationScope', 'TrackingDevice', 'Invoice']) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect([...schema.matchAll(/^model\s+\w+\s*\{/gm)]).toHaveLength(86);
  });
  it('không còn bảng ca và pick task riêng', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/^model\s+(WorkShift|ShiftAssignment|PickTask|FulfillmentOrder)\s*\{/m);
  });
});
