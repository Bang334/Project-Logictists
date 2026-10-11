import * as dotenv from 'dotenv';
import { PrismaClient, Branch, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PERMISSIONS, DISPATCHER_PERMISSIONS } from '../src/auth/access';

export function requiredDemoPassword(): string {
  const value = process.env.AUTH_DEMO_PASSWORD;
  if (!value || Buffer.byteLength(value) < 12 || Buffer.byteLength(value) > 72) throw new Error('AUTH_DEMO_PASSWORD phải được cấu hình, từ 12 đến 72 bytes; không dùng mật khẩu thật');
  return value;
}
export async function seedAuth(prisma: PrismaClient) {
  const password = await bcrypt.hash(requiredDemoPassword(), 12);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(260926, 1)`;
    const roles: Record<string, string> = {};
    for (const code of ['ADMIN', 'DISPATCHER'] as const) {
      const role = await tx.accessRole.upsert({ where: { code }, update: {}, create: { code, name: code, description: 'TMS MVP role' } });
      roles[code] = role.id;
      // users.read/create/lock are ADMIN-only; the live username gate is enforced by hasPermission.
      // Upserting grants on roles does not add COMPANY scopes to any existing account.
      for (const permission of (code === 'ADMIN' ? PERMISSIONS : DISPATCHER_PERMISSIONS)) {
        const p = await tx.permission.upsert({ where: { code: permission }, update: {}, create: { code: permission, description: permission } });
        await tx.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: p.id } }, update: {}, create: { roleId: role.id, permissionId: p.id } });
      }
    }
    const branches: Branch[] = [];
    for (const letter of ['A', 'B']) {
      const code = 'DEMO-AUTH-' + letter;
      const existing = await tx.branch.findUnique({ where: { code } });
      if (existing && !existing.name.startsWith('[DEMO AUTH]')) throw new Error('Trùng mã chi nhánh với dữ liệu ngoài demo');
      branches.push(await tx.branch.upsert({ where: { code }, update: {}, create: { code, name: '[DEMO AUTH] Chi nhánh ' + letter, address: 'Địa chỉ minh họa ' + letter, latitude: letter === 'A' ? 21.03 : 10.77, longitude: letter === 'A' ? 105.85 : 106.69 } }));
    }
    const users: User[] = [];
    for (const [username, role, branchIndex, active] of [
      ['demo_auth_admin', 'ADMIN', null, true],
      ['demo_auth_a', 'DISPATCHER', 0, true],
      ['demo_auth_b', 'DISPATCHER', 1, true],
      ['demo_auth_locked', 'DISPATCHER', null, false],
      ['demo_auth_no_scope', 'DISPATCHER', null, true],
    ] as const) {
      const existing = await tx.user.findUnique({ where: { username } });
      if (existing && !existing.fullName.startsWith('[DEMO AUTH]')) throw new Error('Trùng tên tài khoản với dữ liệu ngoài demo');
      const user = await tx.user.upsert({ where: { username }, update: {}, create: { username, password, role, branchId: branchIndex === null ? null : branches[branchIndex].id, fullName: '[DEMO AUTH] ' + username, active } });
      users.push(user);
      // Existing accounts are never silently reactivated or given revoked scopes on a rerun.
      if (!existing && (role === 'ADMIN' || branchIndex !== null)) {
        await tx.userRoleScope.create({ data: { userId: user.id, roleId: roles[role], scopeType: role === 'ADMIN' ? 'COMPANY' : 'BRANCH', branchId: branchIndex === null ? null : branches[branchIndex].id } });
      }
    }
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i];
      const label = i === 0 ? 'A' : 'B';
      const customer = await tx.customer.upsert({ where: { code: 'DEMO-AUTH-CUSTOMER-' + label }, update: {}, create: { code: 'DEMO-AUTH-CUSTOMER-' + label, name: '[DEMO AUTH] Khách ' + label, address: 'Địa chỉ demo', contactPerson: 'Demo', phone: '000000000' + i } });
      const vehicleType = await tx.vehicleType.upsert({ where: { code: 'DEMO-AUTH' }, update: {}, create: { code: 'DEMO-AUTH', name: 'Demo', payloadCapacityKg: 1000, volumeCapacityM3: 10, lengthCm: 400, widthCm: 200, heightCm: 200 } });
      const vehicle = await tx.vehicle.upsert({ where: { plateNumber: 'DEMO-AUTH-' + label }, update: {}, create: { plateNumber: 'DEMO-AUTH-' + label, model: '[DEMO AUTH]', vehicleTypeId: vehicleType.id, homeBranchId: branch.id } });
      const driver = await tx.driver.upsert({ where: { citizenId: 'DEMO-AUTH-' + label }, update: {}, create: { citizenId: 'DEMO-AUTH-' + label, fullName: '[DEMO AUTH] Tài xế ' + label, phone: '0000000000', licenseNumber: 'DEMO-AUTH-' + label, licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: branch.id } });
      await tx.order.upsert({ where: { orderNumber: 'DEMO-AUTH-ORDER-' + label }, update: {}, create: { orderNumber: 'DEMO-AUTH-ORDER-' + label, customerId: customer.id, branchId: branch.id, totalWeightKg: 10, totalPackages: 1, totalVolumeM3: 0.008, notes: '[DEMO AUTH] Dữ liệu kiểm tra quyền', stops: { create: ['PICKUP', 'DELIVERY'].map((type: 'PICKUP' | 'DELIVERY', index) => ({ type, sequence: index + 1, address: '[DEMO AUTH] ' + type, latitude: branch.latitude + index * 0.01, longitude: branch.longitude, contactName: 'Demo', contactPhone: '0000000000' })) }, items: { create: { description: '[DEMO AUTH] Kiện mẫu', quantity: 1, weightKg: 10, lengthCm: 20, widthCm: 20, heightCm: 20, volumeM3: 0.008 } } } });
      await tx.trip.upsert({ where: { tripNumber: 'DEMO-AUTH-TRIP-' + label }, update: {}, create: { tripNumber: 'DEMO-AUTH-TRIP-' + label, managingBranchId: branch.id, vehicleId: vehicle.id, status: 'DRAFT', plannedStartTime: new Date('2030-01-01T01:00:00Z'), plannedEndTime: new Date('2030-01-01T05:00:00Z'), notes: '[DEMO AUTH] Chỉ kiểm tra quyền, không phải kế hoạch vận tải khả thi', assignments: { create: { driverId: driver.id, startTime: new Date('2030-01-01T01:00:00Z'), endTime: new Date('2030-01-01T05:00:00Z') } } } });
    }
    return { branches: branches.map(b => ({ id: b.id, code: b.code })), usernames: users.map(u => u.username) };
  }, { timeout: 30000 });
}
if (require.main === module) {
  dotenv.config();
  const prisma = new PrismaClient();
  seedAuth(prisma).then(result => console.log(result)).catch(() => { console.error('Seed auth thất bại; kiểm tra cấu hình, migration và trùng mã demo'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
