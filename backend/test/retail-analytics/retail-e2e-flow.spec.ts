import { readFileSync } from 'fs';
import { join } from 'path';

describe('Merged retail and TMS database contract', () => {
  it('giữ model retail/TMS/auth và lịch sử thực thi sau khi đơn giản lịch/cửa xe', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    for (const model of ['AuthSession', 'AuthLoginLimit', 'Allocation', 'Package', 'OrderStop', 'UserRoleScope', 'UserLocationScope', 'TrackingDevice', 'Invoice', 'TripExecutionSnapshot', 'PickupResult', 'DriverDeliveryState']) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect([...schema.matchAll(/^model\s+\w+\s*\{/gm)]).toHaveLength(86);
    expect(schema).not.toMatch(/^model\s+(DriverShift|DriverLeave|VehicleDoor)\s*\{/m);
  });
  it('không còn bảng ca và pick task riêng', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).not.toMatch(/^model\s+(WorkShift|ShiftAssignment|PickTask|FulfillmentOrder)\s*\{/m);
  });
});
