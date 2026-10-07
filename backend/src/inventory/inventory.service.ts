import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { AuditLogService } from '../common/services/audit-log.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import {
  CreateReservationDto,
  CommitReservationDto,
  ReleaseReservationDto,
} from './dto/create-reservation.dto';
import { QueryStockDto } from './dto/query-stock.dto';
import { LedgerSourceType, ReservationStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotencyService: IdempotencyService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ================= 1. CREATE INVENTORY RESERVATION (GIỮ HÀNG CHỐNG OVERSELL) =================
  async createReservation(
    dto: CreateReservationDto,
    userId?: string,
    accessLocationId?: string,
  ) {
    if (accessLocationId && accessLocationId !== dto.locationId) {
      throw new ForbiddenException('Không được giữ tồn kho ngoài địa điểm được gán');
    }
    const idem = await this.idempotencyService.checkOrStartCommand(
      userId || 'system',
      'INVENTORY_RESERVE',
      dto.idempotencyKey,
      dto,
    );
    if (idem.isProcessed) {
      return idem.result;
    }

    try {
      const ttlMinutes = dto.ttlMinutes ?? this.getConfiguredReservationTtlMinutes();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      const result = await this.prisma.$transaction((tx) =>
        this.reserveStockInTransaction(tx, dto, userId, expiresAt),
      );

      await this.idempotencyService.completeCommand(idem.commandRecordId, result);
      return result;
    } catch (err) {
      await this.idempotencyService.failCommand(
        idem.commandRecordId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Giữ tồn trong transaction do caller sở hữu. Khóa từng StockBalance bằng
   * SELECT ... FOR UPDATE theo thứ tự SKU ổn định để hai checkout đồng thời
   * không thể cùng tiêu thụ lượng sellable cuối cùng.
   */
  async reserveStockInTransaction(
    tx: Prisma.TransactionClient,
    dto: CreateReservationDto,
    userId?: string,
    expiresAt = new Date(
      Date.now() +
        (dto.ttlMinutes ?? this.getConfiguredReservationTtlMinutes()) * 60 * 1000,
    ),
  ) {
    const skuIds = dto.lines.map((line) => line.skuId);
    if (new Set(skuIds).size !== skuIds.length) {
      throw new BadRequestException('Mỗi SKU chỉ được xuất hiện một lần trong yêu cầu giữ tồn');
    }

    const sortedLines = [...dto.lines].sort((a, b) =>
      a.skuId.localeCompare(b.skuId),
    );
    const reservations: any[] = [];

    for (const line of sortedLines) {
      await tx.$queryRaw`
        SELECT "id"
        FROM "stock_balances"
        WHERE "skuId" = ${line.skuId}
          AND "locationId" = ${dto.locationId}
        FOR UPDATE
      `;

      const balance = await tx.stockBalance.findUnique({
        where: {
          skuId_locationId: {
            skuId: line.skuId,
            locationId: dto.locationId,
          },
        },
      });

      if (!balance) {
        throw new NotFoundException(
          `SKU ${line.skuId} chưa có bản ghi tồn kho tại địa điểm ${dto.locationId}`,
        );
      }

      const sellable = Math.max(
        0,
        balance.onHand - balance.reserved - balance.safetyBuffer,
      );
      if (sellable < line.quantity) {
        throw new ConflictException(
          `Không đủ tồn kho khả dụng cho SKU ${line.skuId}: Yêu cầu ${line.quantity}, hiện khả dụng ${sellable} (Tồn vật lý: ${balance.onHand}, Đã giữ: ${balance.reserved}, Đệm an toàn: ${balance.safetyBuffer})`,
        );
      }

      await tx.stockBalance.update({
        where: { id: balance.id },
        data: {
          reserved: { increment: line.quantity },
          version: { increment: 1 },
        },
      });

      const reservation = await tx.inventoryReservation.create({
        data: {
          reservationNumber: `RES-${randomUUID()}`,
          orderId: dto.salesOrderId,
          skuId: line.skuId,
          locationId: dto.locationId,
          quantity: line.quantity,
          status: ReservationStatus.ACTIVE,
          expiresAt,
          createdById: userId,
        },
      });
      reservations.push(reservation);
    }

    return {
      locationId: dto.locationId,
      salesOrderId: dto.salesOrderId,
      expiresAt,
      reservations,
    };
  }

  // ================= 2. COMMIT RESERVATION (XÁC NHẬN PICK / XUẤT HÀNG) =================
  async commitReservation(
    reservationId: string,
    dto: CommitReservationDto,
    userId?: string,
    accessLocationId?: string,
  ) {
    const idem = await this.idempotencyService.checkOrStartCommand(
      userId || 'system',
      'INVENTORY_COMMIT',
      dto.idempotencyKey,
      { reservationId, ...dto },
    );
    if (idem.isProcessed) {
      return idem.result;
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT "id"
          FROM "inventory_reservations"
          WHERE "id" = ${reservationId}
          FOR UPDATE
        `;
        const res = await tx.inventoryReservation.findUnique({
          where: { id: reservationId },
        });

        if (!res) {
          throw new NotFoundException(`Không tìm thấy giữ chỗ tồn kho ${reservationId}`);
        }

        if (accessLocationId && res.locationId !== accessLocationId) {
          throw new ForbiddenException('Không được commit tồn kho ngoài địa điểm được gán');
        }

        if (res.status !== ReservationStatus.ACTIVE) {
          throw new ConflictException(
            `Không thể commit giữ chỗ ở trạng thái ${res.status}. Chỉ được commit khi ACTIVE.`,
          );
        }

        await tx.$queryRaw`
          SELECT "id"
          FROM "stock_balances"
          WHERE "skuId" = ${res.skuId}
            AND "locationId" = ${res.locationId}
          FOR UPDATE
        `;
        const balance = await tx.stockBalance.findUnique({
          where: {
            skuId_locationId: {
              skuId: res.skuId,
              locationId: res.locationId,
            },
          },
        });

        if (!balance) {
          throw new NotFoundException('Không tìm thấy bản ghi số dư tồn kho để commit');
        }

        if (
          balance.reserved < res.quantity ||
          balance.onHand < res.quantity
        ) {
          throw new ConflictException(
            'Số dư tồn kho không nhất quán với reservation; cần đối soát trước khi commit',
          );
        }

        const newOnHand = balance.onHand - res.quantity;
        const newReserved = balance.reserved - res.quantity;

        // 1. Cập nhật StockBalance: giảm onHand và giảm reserved
        await tx.stockBalance.update({
          where: { id: balance.id },
          data: {
            onHand: newOnHand,
            reserved: newReserved,
            version: { increment: 1 },
          },
        });

        // 2. Chuyển trạng thái reservation sang COMMITTED
        const updatedReservation = await tx.inventoryReservation.update({
          where: { id: res.id },
          data: {
            status: ReservationStatus.COMMITTED,
            committedAt: new Date(),
          },
        });

        // 3. Ghi StockLedgerEntry bất biến (RR24)
        await tx.stockLedgerEntry.create({
          data: {
            skuId: res.skuId,
            locationId: res.locationId,
            sourceType: LedgerSourceType.ORDER_COMMIT,
            sourceId: res.orderId || res.id,
            commandKey: dto.idempotencyKey,
            quantity: -res.quantity, // Lượng xuất kho âm
            balanceAfter: newOnHand,
            note: `Commit xuất kho cho đơn hàng / giữ chỗ ${res.reservationNumber}`,
            createdById: userId,
          },
        });

        return updatedReservation;
      });

      await this.idempotencyService.completeCommand(idem.commandRecordId, result);
      return result;
    } catch (err) {
      await this.idempotencyService.failCommand(
        idem.commandRecordId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  // ================= 3. RELEASE RESERVATION (HỦY ĐƠN HOẶC HẾT HẠN) =================
  async releaseReservation(
    reservationId: string,
    dto: ReleaseReservationDto,
    userId?: string,
    accessLocationId?: string,
  ) {
    const idem = await this.idempotencyService.checkOrStartCommand(
      userId || 'system',
      'INVENTORY_RELEASE',
      dto.idempotencyKey,
      { reservationId, ...dto },
    );
    if (idem.isProcessed) {
      return idem.result;
    }

    try {
      const result = await this.prisma.$transaction((tx) =>
        this.releaseReservationInTransaction(
          tx,
          reservationId,
          accessLocationId,
        ),
      );

      await this.idempotencyService.completeCommand(idem.commandRecordId, result);
      return result;
    } catch (err) {
      await this.idempotencyService.failCommand(
        idem.commandRecordId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  async releaseReservationInTransaction(
    tx: Prisma.TransactionClient,
    reservationId: string,
    accessLocationId?: string,
  ) {
    await tx.$queryRaw`
      SELECT "id"
      FROM "inventory_reservations"
      WHERE "id" = ${reservationId}
      FOR UPDATE
    `;

    const reservation = await tx.inventoryReservation.findUnique({
      where: { id: reservationId },
    });
    if (!reservation) {
      throw new NotFoundException(`Không tìm thấy giữ chỗ tồn kho ${reservationId}`);
    }
    if (accessLocationId && reservation.locationId !== accessLocationId) {
      throw new ForbiddenException('Không được giải phóng tồn kho ngoài địa điểm được gán');
    }
    if (reservation.status === ReservationStatus.COMMITTED) {
      throw new ConflictException(
        'Không được giải phóng giữ chỗ đã được COMMIT xuất hàng thực tế.',
      );
    }
    if (reservation.status === ReservationStatus.RELEASED) {
      return reservation;
    }

    await tx.$queryRaw`
      SELECT "id"
      FROM "stock_balances"
      WHERE "skuId" = ${reservation.skuId}
        AND "locationId" = ${reservation.locationId}
      FOR UPDATE
    `;
    const balance = await tx.stockBalance.findUnique({
      where: {
        skuId_locationId: {
          skuId: reservation.skuId,
          locationId: reservation.locationId,
        },
      },
    });
    if (!balance || balance.reserved < reservation.quantity) {
      throw new ConflictException(
        'Số dư reserved không nhất quán với reservation; cần đối soát trước khi giải phóng',
      );
    }

    await tx.stockBalance.update({
      where: { id: balance.id },
      data: {
        reserved: { decrement: reservation.quantity },
        version: { increment: 1 },
      },
    });

    return tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: {
        status: ReservationStatus.RELEASED,
        releasedAt: new Date(),
      },
    });
  }

  /**
   * Quyết toán toàn bộ reservation của một đơn sau khi pick hoàn tất.
   *
   * Dòng đã pick được commit, phần short-pick được tách thành reservation
   * RELEASED để vẫn giữ được dấu vết số lượng đã đặt ban đầu. Caller phải
   * chạy hàm này trong cùng transaction với chuyển trạng thái PickTask.
   */
  async settleOrderReservationsInTransaction(
    tx: Prisma.TransactionClient,
    salesOrderId: string,
    locationId: string,
    pickedQuantityBySku: ReadonlyMap<string, number>,
    userId?: string,
    commandKey?: string,
  ) {
    const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "inventory_reservations"
       WHERE "orderId" = ${salesOrderId}
        AND "locationId" = ${locationId}
        AND "status" = 'ACTIVE'
      ORDER BY "skuId", "id"
      FOR UPDATE
    `;

    if (lockedRows.length === 0) {
      return { committedQuantity: 0, releasedQuantity: 0 };
    }

    const reservations = await tx.inventoryReservation.findMany({
      where: { id: { in: lockedRows.map((row) => row.id) } },
      orderBy: [{ skuId: 'asc' }, { id: 'asc' }],
    });
    const remainingToCommit = new Map(pickedQuantityBySku);
    let committedQuantity = 0;
    let releasedQuantity = 0;

    for (const reservation of reservations) {
      await tx.$queryRaw`
        SELECT "id"
        FROM "stock_balances"
        WHERE "skuId" = ${reservation.skuId}
          AND "locationId" = ${locationId}
        FOR UPDATE
      `;
      const balance = await tx.stockBalance.findUnique({
        where: {
          skuId_locationId: { skuId: reservation.skuId, locationId },
        },
      });
      if (!balance) {
        throw new ConflictException(
          `Không tìm thấy số dư tồn kho cho SKU ${reservation.skuId} khi quyết toán pick`,
        );
      }

      const requestedCommit = remainingToCommit.get(reservation.skuId) ?? 0;
      const commitQuantity = Math.min(reservation.quantity, requestedCommit);
      const releaseQuantity = reservation.quantity - commitQuantity;
      if (
        balance.reserved < reservation.quantity ||
        balance.onHand < commitQuantity
      ) {
        throw new ConflictException(
          `Số dư tồn kho SKU ${reservation.skuId} không nhất quán với reservation; cần đối soát trước khi xuất kho`,
        );
      }

      const newOnHand = balance.onHand - commitQuantity;
      const newReserved = balance.reserved - reservation.quantity;
      await tx.stockBalance.update({
        where: { id: balance.id },
        data: {
          onHand: newOnHand,
          reserved: newReserved,
          version: { increment: 1 },
        },
      });

      if (commitQuantity > 0) {
        await tx.inventoryReservation.update({
          where: { id: reservation.id },
          data: {
            quantity: commitQuantity,
            status: ReservationStatus.COMMITTED,
            committedAt: new Date(),
          },
        });
        await tx.stockLedgerEntry.create({
          data: {
            skuId: reservation.skuId,
            locationId,
            sourceType: LedgerSourceType.ORDER_COMMIT,
            sourceId: salesOrderId,
            commandKey,
            quantity: -commitQuantity,
            balanceAfter: newOnHand,
            note: `Xuất kho theo kết quả pick cho đơn ${salesOrderId}`,
            createdById: userId,
          },
        });
        committedQuantity += commitQuantity;
      } else {
        await tx.inventoryReservation.update({
          where: { id: reservation.id },
          data: {
            status: ReservationStatus.RELEASED,
            releasedAt: new Date(),
          },
        });
      }

      if (releaseQuantity > 0) {
        if (commitQuantity > 0) {
          await tx.inventoryReservation.create({
            data: {
              reservationNumber: `RES-${randomUUID()}`,
              orderId: salesOrderId,
              skuId: reservation.skuId,
              locationId,
              quantity: releaseQuantity,
              status: ReservationStatus.RELEASED,
              expiresAt: reservation.expiresAt,
              releasedAt: new Date(),
              createdById: reservation.createdById,
            },
          });
        }
        await tx.stockLedgerEntry.create({
          data: {
            skuId: reservation.skuId,
            locationId,
            sourceType: LedgerSourceType.ORDER_RELEASE,
            sourceId: salesOrderId,
            commandKey,
            quantity: 0,
            balanceAfter: newOnHand,
            note: `Giải phóng ${releaseQuantity} sản phẩm short-pick của đơn ${salesOrderId}`,
            createdById: userId,
          },
        });
        releasedQuantity += releaseQuantity;
      }

      remainingToCommit.set(
        reservation.skuId,
        Math.max(0, requestedCommit - commitQuantity),
      );
    }

    const unsettled = [...remainingToCommit.entries()].find(([, quantity]) => quantity > 0);
    if (unsettled) {
      throw new ConflictException(
        `Lượng pick SKU ${unsettled[0]} vượt reservation đang hoạt động`,
      );
    }

    return { committedQuantity, releasedQuantity };
  }

  /** Di chuyển reservation của đơn sang nguồn mới trong một transaction. */
  async moveOrderReservationsInTransaction(
    tx: Prisma.TransactionClient,
    salesOrderId: string,
    destinationLocationId: string,
    lines: ReadonlyArray<{ skuId: string; quantity: number }>,
    userId?: string,
  ) {
    await tx.$queryRaw`
      SELECT "id"
      FROM "inventory_reservations"
       WHERE "orderId" = ${salesOrderId}
        AND "status" = 'ACTIVE'
      ORDER BY "skuId", "id"
      FOR UPDATE
    `;
    const activeReservations = await tx.inventoryReservation.findMany({
      where: { orderId: salesOrderId, status: ReservationStatus.ACTIVE },
      orderBy: [{ skuId: 'asc' }, { id: 'asc' }],
    });

    const alreadyAtDestination =
      activeReservations.length > 0 &&
      activeReservations.every((reservation) => reservation.locationId === destinationLocationId);
    if (alreadyAtDestination) {
      return { reservations: activeReservations, moved: false };
    }

    const expiryCandidates = activeReservations.map((reservation) => reservation.expiresAt.getTime());
    const expiresAt = new Date(
      expiryCandidates.length > 0
        ? Math.min(...expiryCandidates)
        : Date.now() + this.getConfiguredReservationTtlMinutes() * 60 * 1000,
    );

    for (const reservation of activeReservations) {
      await this.releaseReservationInTransaction(tx, reservation.id);
    }

    const result = await this.reserveStockInTransaction(
      tx,
      {
        salesOrderId,
        locationId: destinationLocationId,
        idempotencyKey: `allocation:${salesOrderId}:${destinationLocationId}`,
        lines: [...lines],
      },
      userId,
      expiresAt,
    );

    return { reservations: result.reservations, moved: true };
  }

  private getConfiguredReservationTtlMinutes(): number {
    const raw = process.env.RETAIL_RESERVATION_TTL_MINUTES;
    const value = raw ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(
        'Chưa cấu hình RETAIL_RESERVATION_TTL_MINUTES cho chính sách giữ tồn kho',
      );
    }
    return value;
  }

  // ================= 4. STOCK RECEIPT (NHẬP HÀNG ĐẦU KỲ / NHÀ CUNG CẤP) =================
  async createReceipt(dto: CreateReceiptDto, userId?: string) {
    const idem = await this.idempotencyService.checkOrStartCommand(
      userId || 'system',
      'STOCK_RECEIPT',
      dto.idempotencyKey,
      dto,
    );
    if (idem.isProcessed) {
      return idem.result;
    }

    try {
      const receiptNumber = `REC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

      const result = await this.prisma.$transaction(async (tx) => {
        const receipt = await tx.stockReceipt.create({
          data: {
            receiptNumber,
            locationId: dto.locationId,
            supplierName: dto.supplierName,
            status: 'COMPLETED',
            receivedById: userId,
          },
        });

        for (const line of dto.lines) {
          await tx.stockReceiptLine.create({
            data: {
              receiptId: receipt.id,
              skuId: line.skuId,
              quantity: line.quantity,
            },
          });

          // Cập nhật hoặc tạo StockBalance
          const balance = await tx.stockBalance.upsert({
            where: {
              skuId_locationId: {
                skuId: line.skuId,
                locationId: dto.locationId,
              },
            },
            update: {
              onHand: { increment: line.quantity },
              version: { increment: 1 },
            },
            create: {
              skuId: line.skuId,
              locationId: dto.locationId,
              onHand: line.quantity,
              reserved: 0,
              safetyBuffer: 2,
            },
          });

          // Ghi StockLedgerEntry
          await tx.stockLedgerEntry.create({
            data: {
              skuId: line.skuId,
              locationId: dto.locationId,
              sourceType: LedgerSourceType.RECEIPT,
              sourceId: receipt.id,
              commandKey: dto.idempotencyKey,
              quantity: line.quantity,
              balanceAfter: balance.onHand,
              note: `Nhập kho từ phiếu ${receiptNumber}`,
              createdById: userId,
            },
          });
        }

        return receipt;
      });

      await this.idempotencyService.completeCommand(idem.commandRecordId, result);
      return result;
    } catch (err) {
      await this.idempotencyService.failCommand(
        idem.commandRecordId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  // ================= 5. STOCK ADJUSTMENT (ĐIỀU CHỈNH TỒN KHO CÓ LÝ DO) =================
  async createAdjustment(dto: CreateAdjustmentDto, userId?: string) {
    const idem = await this.idempotencyService.checkOrStartCommand(
      userId || 'system',
      'STOCK_ADJUSTMENT',
      dto.idempotencyKey,
      dto,
    );
    if (idem.isProcessed) {
      return idem.result;
    }

    try {
      const adjustmentNumber = `ADJ-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

      const result = await this.prisma.$transaction(async (tx) => {
        const adjustment = await tx.stockAdjustment.create({
          data: {
            adjustmentNumber,
            locationId: dto.locationId,
            reason: dto.reason,
            note: dto.note,
            status: 'APPROVED',
            createdById: userId,
          },
        });

        for (const line of dto.lines) {
          const balance = await tx.stockBalance.findUnique({
            where: {
              skuId_locationId: {
                skuId: line.skuId,
                locationId: dto.locationId,
              },
            },
          });

          if (!balance) {
            throw new NotFoundException(`Chưa có số dư tồn kho cho SKU ${line.skuId}`);
          }

          const newOnHand = balance.onHand + line.deltaQuantity;
          if (newOnHand < 0) {
            throw new BadRequestException(
              `Điều chỉnh âm ${line.deltaQuantity} vượt quá số tồn hiện tại (${balance.onHand}) của SKU ${line.skuId}`,
            );
          }

          await tx.stockAdjustmentLine.create({
            data: {
              adjustmentId: adjustment.id,
              skuId: line.skuId,
              deltaQuantity: line.deltaQuantity,
            },
          });

          await tx.stockBalance.update({
            where: { id: balance.id },
            data: {
              onHand: newOnHand,
              version: { increment: 1 },
            },
          });

          await tx.stockLedgerEntry.create({
            data: {
              skuId: line.skuId,
              locationId: dto.locationId,
              sourceType: LedgerSourceType.ADJUSTMENT,
              sourceId: adjustment.id,
              commandKey: dto.idempotencyKey,
              quantity: line.deltaQuantity,
              balanceAfter: newOnHand,
              note: `Điều chỉnh tồn: ${dto.reason} (${dto.note || ''})`,
              createdById: userId,
            },
          });
        }

        return adjustment;
      });

      await this.idempotencyService.completeCommand(idem.commandRecordId, result);
      return result;
    } catch (err) {
      await this.idempotencyService.failCommand(
        idem.commandRecordId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  // ================= 6. QUERY STOCK BALANCES & AVAILABILITY =================
  async queryStock(query: QueryStockDto) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.locationId) where.locationId = query.locationId;
    if (query.skuId) where.skuId = query.skuId;

    const [total, balances] = await Promise.all([
      this.prisma.stockBalance.count({ where }),
      this.prisma.stockBalance.findMany({
        where,
        skip,
        take: limit,
        include: {
          sku: {
            include: {
              product: true,
            },
          },
          location: true,
        },
        orderBy: [{ locationId: 'asc' }, { skuId: 'asc' }],
      }),
    ]);

    const items = balances.map((b) => {
      const sellable = Math.max(0, b.onHand - b.reserved - b.safetyBuffer);
      return {
        ...b,
        sellable,
      };
    });

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
