import {
  Injectable,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

const PROCESSING_LEASE_MS = 5 * 60 * 1000;

export type IdempotencyCheckResult<T = any> =
  | { isProcessed: true; result: T }
  | { isProcessed: false; commandRecordId: string };

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tính hash SHA-256 của request payload để phát hiện payload mismatch
   */
  hashPayload(payload: any): string {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    return createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Kiểm tra xem lệnh đã được xử lý trước đó hay chưa (RR07, RT02, RT03)
   */
  async checkOrStartCommand<T = any>(
    actorUserId: string,
    commandType: string,
    idempotencyKey: string,
    payload: any,
  ): Promise<IdempotencyCheckResult<T>> {
    const requestHash = this.hashPayload(payload);

    const existing = await this.prisma.processedCommand.findUnique({
      where: {
        actorUserId_commandType_idempotencyKey: {
          actorUserId,
          commandType,
          idempotencyKey,
        },
      },
    });

    if (existing) {
      return this.resolveExistingCommand<T>(
        existing,
        requestHash,
        commandType,
        idempotencyKey,
      );
    }

    // createMany + skipDuplicates là thao tác claim nguyên tử. Hai request cùng
    // key không thể cùng nhận quyền thực thi như cách find-then-upsert trước đây.
    const inserted = await this.prisma.processedCommand.createMany({
      data: [{
        actorUserId,
        commandType,
        idempotencyKey,
        requestHash,
        status: 'PROCESSING',
      }],
      skipDuplicates: true,
    });

    const claimed = await this.prisma.processedCommand.findUnique({
      where: {
        actorUserId_commandType_idempotencyKey: {
          actorUserId,
          commandType,
          idempotencyKey,
        },
      },
    });
    if (!claimed) {
      throw new ConflictException('Không thể xác nhận trạng thái lệnh idempotent');
    }
    if (inserted.count === 1) {
      return { isProcessed: false, commandRecordId: claimed.id };
    }
    return this.resolveExistingCommand<T>(
      claimed,
      requestHash,
      commandType,
      idempotencyKey,
    );
  }

  private async resolveExistingCommand<T>(
    existing: {
      id: string;
      requestHash: string;
      status: string;
      result: unknown;
      updatedAt?: Date;
    },
    requestHash: string,
    commandType: string,
    idempotencyKey: string,
  ): Promise<IdempotencyCheckResult<T>> {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException(
        'Lệnh bị từ chối: Cùng idempotency key nhưng nội dung payload khác với lần gửi trước (CONFLICT_PAYLOAD_MISMATCH)',
      );
    }
    if (existing.status === 'COMPLETED' && existing.result) {
      this.logger.log(
        `Idempotency hit: Command ${commandType} (${idempotencyKey}) trả về kết quả đã xử lý.`,
      );
      return { isProcessed: true, result: existing.result as T };
    }

    const leaseExpired =
      existing.status === 'PROCESSING' &&
      existing.updatedAt instanceof Date &&
      existing.updatedAt.getTime() < Date.now() - PROCESSING_LEASE_MS;
    if (existing.status === 'FAILED' || leaseExpired) {
      const claimed = await this.prisma.processedCommand.updateMany({
        where: {
          id: existing.id,
          status: existing.status,
          ...(existing.updatedAt ? { updatedAt: existing.updatedAt } : {}),
        },
        data: {
          status: 'PROCESSING',
          requestHash,
          result: Prisma.JsonNull,
        },
      });
      if (claimed.count === 1) {
        return { isProcessed: false, commandRecordId: existing.id };
      }
    }

    throw new ConflictException(
      'Lệnh đang trong quá trình xử lý, vui lòng không gửi lặp lại.',
    );
  }

  /**
   * Đánh dấu lệnh hoàn tất thành công và lưu kết quả
   */
  async completeCommand(
    commandRecordId: string,
    result: any,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx || this.prisma;
    await client.processedCommand.update({
      where: { id: commandRecordId },
      data: {
        status: 'COMPLETED',
        result: result ?? {},
      },
    });
  }

  /**
   * Đánh dấu lệnh thất bại để có thể thử lại
   */
  async failCommand(commandRecordId: string, errorReason: string): Promise<void> {
    await this.prisma.processedCommand.update({
      where: { id: commandRecordId },
      data: {
        status: 'FAILED',
        result: { error: errorReason },
      },
    });
  }
}
