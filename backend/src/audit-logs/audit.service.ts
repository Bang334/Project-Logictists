import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Principal, hasPermission, PermissionCode } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { AuditQueryDto } from './audit.dto';
import { allowedActions, auditEntities, AuditSourceRow, projectAudit } from './audit-projection';

export function assertAuditReader(user: Principal) {
  if (!user.grants.some(g => g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.branchId === null)) {
    throw new ForbiddenException({ code: 'AUDIT_ACCESS_DENIED', message: 'Chỉ ADMIN phạm vi công ty được xem nhật ký quản trị' });
  }
}
// Order events remain their original source. In particular, do not select the old full Order snapshot.
const sources = Prisma.sql`
  SELECT 'AUDIT_LOG'::text AS source, a.id, a."entityType", a."entityId", a.action,
    a."actorUserId", a.timestamp, a."changeSummary" AS summary, NULL::text AS "fromStatus", NULL::text AS "toStatus"
  FROM audit_logs a WHERE a."entityType" IN (${Prisma.join(Object.keys(auditEntities))})
  UNION ALL
  SELECT 'ORDER_EVENT'::text, e.id, 'Order'::text, e."orderId", e."eventType", e."actorUserId", e."occurredAt",
    jsonb_build_object('reason', CASE WHEN e."eventType" = 'CANCELLED' THEN e.payload->'reason' ELSE NULL END,
      'auditBranchIds', e.payload->'auditBranchIds'), e."fromStatus", e."toStatus"
  FROM order_status_events e JOIN orders o ON o.id = e."orderId"
  WHERE o."orderType" = 'B2B_TRANSPORT' AND e."eventType" IN ('CREATED','UPDATED','PACKAGES_RECONCILED','CONFIRMED','CANCELLED')`;

type Row = AuditSourceRow & { actorName: string | null };
const knownAction = Prisma.join(Object.entries(allowedActions).map(([entity, actions]) => Prisma.sql`(r."entityType" = ${entity} AND r.action IN (${Prisma.join(actions)}))`), ' OR ');
function safeIds(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN CASE WHEN jsonb_array_length(${value}) <= 100
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${value}) v WHERE jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^[a-zA-Z0-9_-]{1,100}$')
    THEN ${value} ELSE '[]'::jsonb END ELSE '[]'::jsonb END`;
}
const recorded = safeIds(Prisma.sql`r.summary->'auditBranchIds'`);
const historicalBranches = Prisma.sql`CASE WHEN NOT (${knownAction}) THEN '[]'::jsonb
  WHEN jsonb_array_length(${recorded}) > 0 THEN ${recorded}
  WHEN r."entityType" = 'Branch' THEN ${safeIds(Prisma.sql`jsonb_build_array(r."entityId")`)}
  WHEN r."entityType" = 'Customer' THEN ${safeIds(Prisma.sql`r.summary->'previousBranchIds'`)} || ${safeIds(Prisma.sql`r.summary->'branchIds'`)}
  WHEN r.action = 'DRIVER_SCOPE_TRANSFERRED' THEN ${safeIds(Prisma.sql`jsonb_build_array(r.summary->'fromBranchId', r.summary->'toBranchId')`)}
  ELSE '[]'::jsonb END`;
@Injectable()
export class AuditService {
  constructor(private readonly db: PrismaService) {}
  private serialize(row: Row, user: Principal) {
    const result = projectAudit(row);
    const destinations: Record<string, { permission: PermissionCode; path: string }> = {
      Order: { permission: 'orders.read', path: '/orders?order=' },
      Customer: { permission: 'customers.read', path: '/customers?customer=' },
      Vehicle: { permission: 'vehicles.read', path: '/fleet?kind=vehicles&resource=' },
      Driver: { permission: 'drivers.read', path: '/fleet?kind=drivers&resource=' },
      User: { permission: 'users.read', path: '/accounts?account=' },
      Branch: { permission: 'branches.read', path: '/branch-detail?branch=' },
    };
    const kind = result.entityType === 'VehicleUnavailability' ? 'Vehicle' : ['DriverShift', 'EmployeeLeave'].includes(result.entityType) ? 'Driver' : result.entityType;
    const destination = destinations[kind];
    const id = kind === result.entityType ? result.entityId : result.resourceId;
    return { ...result, actorName: row.actorName, objectUrl: destination && id && hasPermission(user, destination.permission) ? destination.path + encodeURIComponent(id) : null };
  }
  async list(query: AuditQueryDto, user: Principal) {
    assertAuditReader(user);
    const from = new Date(query.from), to = new Date(query.to);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 93 * 86400000) {
      throw new BadRequestException({ code: 'AUDIT_TIME_RANGE', message: 'Khoảng [từ, đến) phải tăng dần và không quá 93 ngày' });
    }
    const where = Prisma.sql`r.timestamp >= ${from} AND r.timestamp < ${to}
      ${query.entityType ? Prisma.sql`AND r."entityType" = ${query.entityType}` : Prisma.empty}
      ${query.action ? Prisma.sql`AND r.action = ${query.action}` : Prisma.empty}
      ${query.actorUserId ? Prisma.sql`AND r."actorUserId" = ${query.actorUserId}` : Prisma.empty}
      ${query.branchId ? Prisma.sql`AND (${historicalBranches}) @> ${JSON.stringify([query.branchId])}::jsonb` : Prisma.empty}
      ${query.entityId ? Prisma.sql`AND r."entityId" = ${query.entityId}` : Prisma.empty}`;
    return this.db.$transaction(async tx => {
      const count = await tx.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`WITH r AS (${sources}) SELECT count(*) AS total FROM r WHERE ${where}`);
      const rows = await tx.$queryRaw<Row[]>(Prisma.sql`WITH r AS (${sources}) SELECT r.*, u."fullName" AS "actorName"
        FROM r LEFT JOIN users u ON u.id = r."actorUserId" WHERE ${where}
        ORDER BY r.timestamp DESC, r.id DESC, r.source DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
      return { items: rows.map(r => this.serialize(r, user)), total: Number(count[0].total), page: query.page, pageSize: query.pageSize };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async detail(source: string, id: string, user: Principal) {
    assertAuditReader(user);
    const rows = await this.db.$queryRaw<Row[]>(Prisma.sql`WITH r AS (${sources}) SELECT r.*, u."fullName" AS "actorName"
      FROM r LEFT JOIN users u ON u.id = r."actorUserId" WHERE r.source = ${source} AND r.id = ${id} LIMIT 1`);
    if (!rows[0]) throw new NotFoundException({ code: 'AUDIT_NOT_FOUND', message: 'Không tìm thấy nhật ký trong phạm vi quản trị' });
    return this.serialize(rows[0], user);
  }
}
