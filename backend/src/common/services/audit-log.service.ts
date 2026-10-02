import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateAuditLogParams {
  entityType: string;
  entityId: string;
  action: string;
  performedBy: string;
  actorUserId?: string | null;
  correlationId?: string | null;
  details?: Record<string, any>;
  changeSummary?: Record<string, any>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ghi nhận một sự kiện kiểm toán bất biến vào bảng audit_logs (RR05, R1-05)
   */
  async log(params: CreateAuditLogParams): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          entityType: params.entityType,
          entityId: params.entityId,
          action: params.action,
          performedBy: params.performedBy,
          actorUserId: params.actorUserId || null,
          correlationId: params.correlationId || null,
          details: params.details ? JSON.stringify(params.details) : null,
          changeSummary: params.changeSummary || {},
        },
      });
    } catch (err: any) {
      // Ghi log lỗi nếu không lưu được audit, không làm sập business flow chính
      this.logger.error(
        `Không thể lưu AuditLog cho ${params.entityType}:${params.entityId} action=${params.action}: ${err.message}`,
        err.stack,
      );
    }
  }
}
