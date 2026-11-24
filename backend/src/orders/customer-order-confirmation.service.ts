import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, OrderType, Role } from '@prisma/client';
import { createHash } from 'crypto';
import { assertBranchAccess, AuthenticatedUser } from '../auth/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { validateCustomerOrderForConfirmation } from './customer-order-confirmation.validation';
import {
  ConfirmCustomerOrderDto,
  MAX_ORDER_VERSION,
} from './dto/confirm-customer-order.dto';
import { customerDraftOrigin, lockOrder, orderVersionConflict } from './order-write';

const CONFIRM_COMMAND = 'CONFIRM_CUSTOMER_ORDER';
const ORDER_CONFIRM_LOCK_NAMESPACE = 504023;

export type OrderConfirmationReceipt = {
  orderId: string;
  orderNumber: string;
  status: typeof OrderStatus.CONFIRMED;
  version: number;
  confirmedAt: string;
};

@Injectable()
export class CustomerOrderConfirmationService {
  constructor(private readonly prisma: PrismaService) {}

  confirm(
    id: string,
    dto: ConfirmCustomerOrderDto,
    actor: AuthenticatedUser,
  ): Promise<OrderConfirmationReceipt> {
    if (actor.role !== Role.ADMIN && actor.role !== Role.DISPATCHER) {
      throw new ForbiddenException('Tài khoản không có quyền xác nhận đơn hàng.');
    }
    if (actor.role === Role.DISPATCHER && !actor.branchId) {
      throw new ForbiddenException('Tài khoản chưa được gán chi nhánh.');
    }

    const idempotencyKey = dto.idempotencyKey.toLowerCase();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ orderId: id, expectedVersion: dto.expectedVersion }))
      .digest('hex');

    return this.prisma.$transaction(async (tx) => {
      const lockKey = `${actor.id}:${CONFIRM_COMMAND}:${idempotencyKey}`;
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(${ORDER_CONFIRM_LOCK_NAMESPACE}::int4, hashtext(${lockKey}))
      `;
      await lockOrder(tx, id);

      const order = await tx.order.findUniqueOrThrow({
        where: { id },
        include: {
          stops: { orderBy: { sequence: 'asc' } },
          items: true,
          events: { where: customerDraftOrigin, select: { id: true }, take: 1 },
          _count: { select: { packages: true } },
        },
      });
      assertBranchAccess(actor, order.branchId);

      const commandKey = {
        actorUserId: actor.id,
        commandType: CONFIRM_COMMAND,
        idempotencyKey,
      };
      const previousCommand = await tx.processedCommand.findUnique({
        where: { actorUserId_commandType_idempotencyKey: commandKey },
      });
      if (previousCommand) {
        if (previousCommand.requestHash !== requestHash) {
          throw new ConflictException({
            errorCode: 'ORDER_CONFIRM_IDEMPOTENCY_CONFLICT',
            message: 'Key đã được dùng với nội dung xác nhận khác.',
          });
        }
        const receipt = previousCommand.result;
        if (
          previousCommand.status === 'COMPLETED' &&
          receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
          receipt.orderId === id && receipt.status === OrderStatus.CONFIRMED &&
          typeof receipt.orderNumber === 'string' &&
          typeof receipt.version === 'number' &&
          typeof receipt.confirmedAt === 'string'
        ) {
          return {
            orderId: id,
            orderNumber: receipt.orderNumber,
            status: receipt.status,
            version: receipt.version,
            confirmedAt: receipt.confirmedAt,
          };
        }
        throw new ConflictException({
          errorCode: 'ORDER_STATE_CONFLICT',
          message: 'Kết quả xác nhận trước đó chưa sẵn sàng.',
        });
      }

      if (order.status !== OrderStatus.DRAFT) {
        throw new ConflictException({
          errorCode: 'ORDER_STATE_CONFLICT',
          message: 'Chỉ có thể xác nhận đơn ở trạng thái DRAFT.',
        });
      }
      if (order.version !== dto.expectedVersion || order.version === MAX_ORDER_VERSION) {
        throw orderVersionConflict();
      }
      if (
        order.orderType !== OrderType.B2B_TRANSPORT ||
        !order.events.length ||
        order._count.packages > 0
      ) {
        throw new ConflictException({
          errorCode: 'ORDER_NOT_CONFIRMABLE',
          message: 'Đơn thiếu dấu vết tạo từ ứng dụng Customer hoặc đã có kiện vật lý.',
        });
      }

      const branches = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT active FROM branches WHERE id = ${order.branchId} FOR SHARE
      `;
      if (!branches[0]?.active) {
        throw new UnprocessableEntityException({
          errorCode: 'ORDER_BRANCH_INACTIVE',
          message: 'Chi nhánh của đơn không còn hoạt động.',
        });
      }

      validateCustomerOrderForConfirmation(order);

      const version = order.version + 1;
      const changed = await tx.order.updateMany({
        where: { id, status: OrderStatus.DRAFT, version: dto.expectedVersion },
        data: { status: OrderStatus.CONFIRMED, version: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw orderVersionConflict();
      }

      const command = await tx.processedCommand.create({
        data: { ...commandKey, requestHash, status: 'PROCESSING' },
        select: { id: true },
      });
      const event = await tx.orderEvent.create({
        data: {
          orderId: id,
          eventType: 'ORDER_CONFIRMED',
          actorUserId: actor.id,
          commandId: command.id,
          fromStatus: OrderStatus.DRAFT,
          toStatus: OrderStatus.CONFIRMED,
          payload: { branchId: order.branchId, previousVersion: order.version, version },
        },
        select: { occurredAt: true },
      });
      const receipt: OrderConfirmationReceipt = {
        orderId: id,
        orderNumber: order.orderNumber,
        status: OrderStatus.CONFIRMED,
        version,
        confirmedAt: event.occurredAt.toISOString(),
      };
      await tx.processedCommand.update({
        where: { id: command.id },
        data: { status: 'COMPLETED', result: receipt },
      });
      return receipt;
    });
  }
}
