import { readFileSync } from 'fs';
import { join } from 'path';

describe('Merged retail and TMS database contract', () => {
  it('giữ model retail/TMS/auth và lịch sử thực thi sau khi đơn giản lịch/cửa xe', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    for (const model of ['AuthSession', 'AuthLoginLimit', 'Allocation', 'Package', 'OrderStop', 'UserRoleScope', 'UserLocationScope', 'TrackingDevice', 'Invoice', 'TripExecutionSnapshot', 'PickupResult', 'DriverDeliveryState']) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect([...schema.matchAll(/^model\s+\w+\s*\{/gm)]).toHaveLength(88);
    expect(schema).toContain('model CustomerBranch {');
    expect(schema).toContain('@@id([customerId, branchId])');
    expect(schema).not.toMatch(/^model\s+(DriverLeave|VehicleDoor)\s*\{/m);
    // Individual dated shifts supersede the branch-only calendar decision on 17/10.
    const shift = schema.match(/model DriverShift \{([\s\S]*?)\n\}/)?.[1];
    expect(shift).toBeDefined();
    for (const field of ['driverId', 'startsAt', 'endsAt', 'version', 'recordedById']) {
      expect(shift).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });
  it('không còn bảng ca và pick task riêng', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/^model\s+(WorkShift|ShiftAssignment|PickTask|FulfillmentOrder)\s*\{/m);
  });
});
