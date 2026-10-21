import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Principal } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
export function isFleetDatabaseConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientUnknownRequestError &&
    ((e.message.includes('code: "23P01"') && /driver_shifts_overlap|fleet_leave_overlap|fleet_vehicle_overlap/.test(e.message)) ||
     (e.message.includes('code: "23514"') && /FLEET_SCHEDULE_CONFLICT|FLEET_DRIVER_SCHEDULE_OR_LICENSE|FLEET_VEHICLE_UNAVAILABLE/.test(e.message)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export async function fleetCommand<T>(db: PrismaService, user: Principal, kind: string, key: string | undefined, payload: unknown,
  write: (tx: Prisma.TransactionClient) => Promise<string>, read: (tx: Prisma.TransactionClient, id: string) => Promise<T>) {
  if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Cần Idempotency-Key từ 16 đến 100 ký tự' });
  const hash = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  try {
    return await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4203, hashtext(${user.id + ':' + kind + ':' + key}))`;
      const old = await tx.processedCommand.findUnique({ where: { actorUserId_commandType_idempotencyKey: { actorUserId: user.id, commandType: kind, idempotencyKey: key } } });
      if (old) {
        if (old.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Khóa đã dùng với nội dung khác' });
        const result = old.result;
        if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.id !== 'string') throw new ConflictException('Lệnh chưa có kết quả');
        return read(tx, result.id);
      }
      const id = await write(tx);
      await tx.processedCommand.create({ data: { id: randomUUID(), actorUserId: user.id, commandType: kind, idempotencyKey: key, requestHash: hash, status: 'COMPLETED', result: { id } } });
      return read(tx, id);
    }, { timeout: 20000, maxWait: 10000 });
  } catch (e) {
    if (isFleetDatabaseConflict(e) || (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2004'].includes(e.code))) throw new ConflictException({ code: 'FLEET_DATA_CONFLICT', message: 'Định danh hoặc lịch bị trùng/xung đột. Tải lại dữ liệu để đối chiếu.' });
    throw e;
  }
}
