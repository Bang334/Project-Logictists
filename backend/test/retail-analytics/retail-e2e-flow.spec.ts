import { readFileSync } from 'fs';
import { join } from 'path';

describe('Merged retail and TMS database contract', () => {
  it('giữ các model retail/TMS và bổ sung snapshot thực thi cùng kết quả pickup', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    for (const model of ['AuthSession', 'AuthLoginLimit', 'Allocation', 'Package', 'OrderStop', 'UserRoleScope', 'UserLocationScope', 'TrackingDevice', 'Invoice', 'TripExecutionSnapshot', 'PickupResult']) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect([...schema.matchAll(/^model\s+\w+\s*\{/gm)]).toHaveLength(88);
  });
  it('không còn bảng ca và pick task riêng', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/^model\s+(WorkShift|ShiftAssignment|PickTask|FulfillmentOrder)\s*\{/m);
  });
});
