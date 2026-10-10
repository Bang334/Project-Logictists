import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, StopType } from '@prisma/client';
import { CreateOrderDto } from './dto/create-order.dto';
import { packageTotals, serializePackageTotals } from './package-measurements';

export const orderInclude = {
  branch: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, code: true, name: true, phone: true } },
  stops: { orderBy: { sequence: 'asc' as const } },
  items: { include: { packages: { orderBy: { packageCode: 'asc' as const } } }, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;
export type OrderRecord = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export function orderFieldError(field: string, message: string): never {
  throw new BadRequestException({ code: 'ORDER_VALIDATION', message, fieldErrors: [{ field, message }] });
}

export function validateOrderInput(dto: CreateOrderDto, confirmed: boolean) {
  if (dto.stops.length !== 2 || dto.stops.filter(s => s.type === 'PICKUP').length !== 1 || dto.stops.filter(s => s.type === 'DELIVERY').length !== 1) {
    orderFieldError('stops', 'Đơn MVP phải có đúng một điểm lấy và một điểm giao');
  }
  dto.stops.forEach((stop, i) => {
    for (const field of ['address', 'contactName', 'contactPhone'] as const) if (!stop[field].trim()) orderFieldError(`stops.${i}.${field}`, 'Không được để trống');
    for (const field of ['windowStart', 'windowEnd'] as const) if (stop[field] && !Number.isFinite(Date.parse(stop[field]))) orderFieldError(`stops.${i}.${field}`, 'Ngày–giờ không hợp lệ');
    if (Boolean(stop.windowStart) !== Boolean(stop.windowEnd) || (confirmed && !stop.windowStart)) orderFieldError(`stops.${i}.windowStart`, 'Cần nhập đủ ngày–giờ bắt đầu và kết thúc');
    if (stop.windowStart && stop.windowEnd && Date.parse(stop.windowStart) > Date.parse(stop.windowEnd)) orderFieldError(`stops.${i}.windowEnd`, 'Kết thúc khung giờ phải bằng hoặc sau bắt đầu');
  });
  const pickup = dto.stops.find(s => s.type === 'PICKUP');
  const delivery = dto.stops.find(s => s.type === 'DELIVERY');
  // Necessary chronology only. Travel feasibility belongs to dispatch, not this order form.
  if (pickup?.windowStart && delivery?.windowEnd && Date.parse(pickup.windowStart) + pickup.serviceDurationMinutes * 60000 > Date.parse(delivery.windowEnd)) {
    orderFieldError(`stops.${dto.stops.indexOf(delivery)}.windowEnd`, 'Không thể bắt đầu giao sau khi hoàn tất lấy trong các khung giờ này');
  }
  const ids = new Set<string>();
  const unique = (id: string | undefined, field: string) => {
    if (id && ids.has(id)) orderFieldError(field, 'ID bị lặp trong yêu cầu');
    if (id) ids.add(id);
  };
  dto.stops.forEach((s, i) => unique(s.id, `stops.${i}.id`));
  dto.items.forEach((item, i) => {
    if (!item.description.trim() || !item.packageType.trim()) orderFieldError(`items.${i}.description`, 'Dòng hàng phải có mô tả và kiểu đóng gói');
    unique(item.id, `items.${i}.id`);
    item.packages.forEach((p, j) => {
      unique(p.id, `items.${i}.packages.${j}.id`);
      if (BigInt(p.weightG) > 9223372036854775807n) orderFieldError(`items.${i}.packages.${j}.weightG`, 'Khối lượng vượt giới hạn lưu trữ gram');
    });
    packageTotals(item.packages.map(p => ({ ...p, weightG: BigInt(p.weightG) })));
  });
}

export function assertPackageManifest(order: { packageDataStatus: string; items: Array<{ quantity: number; packages: Array<{ lengthMm: number; widthMm: number; heightMm: number; weightG: bigint }> }> }) {
  if (order.packageDataStatus !== 'COMPLETE' || !order.items.length || order.items.some(i => !i.packages.length || i.quantity !== i.packages.length)) {
    throw new ConflictException({ code: 'PACKAGE_REVIEW_REQUIRED', message: 'Đơn chưa có danh sách kiện đã đối soát; không thể điều phối/tối ưu' });
  }
  packageTotals(order.items.flatMap(i => i.packages));
}

/** Dispatch never repairs an incomplete/advanced manifest implicitly. */
export function assertDispatchableOrder(order: {
  status: string; packageDataStatus: string;
  stops: Array<{ type: string; windowBasis: string | null; windowStart: Date | null; windowEnd: Date | null; serviceDurationMinutes: number }>;
  items: Array<{ quantity: number; packages: Array<{ status: string; lengthMm: number; widthMm: number; heightMm: number; weightG: bigint }> }>;
}) {
  assertPackageManifest(order);
  if (order.status !== 'CONFIRMED' || order.items.some(i => i.packages.some(p => p.status !== 'READY'))) {
    throw new ConflictException({ code: 'ORDER_NOT_DISPATCHABLE', message: 'Đơn phải được xác nhận và mọi kiện phải ở trạng thái READY' });
  }
  if (order.stops.length !== 2 || order.stops.filter(s => s.type === 'PICKUP').length !== 1 || order.stops.filter(s => s.type === 'DELIVERY').length !== 1
    || order.stops.some(s => s.windowBasis !== 'SERVICE_START' || !s.windowStart || !s.windowEnd || s.windowStart > s.windowEnd)) {
    throw new ConflictException({ code: 'ORDER_WINDOWS_INVALID', message: 'Cần đúng một điểm lấy, một điểm giao với khung giờ bắt đầu phục vụ hợp lệ' });
  }
}

export function serializeOrder(order: OrderRecord) {
  const complete = order.packageDataStatus === 'COMPLETE';
  if (complete) assertPackageManifest(order);
  const pickup = order.stops.find(s => s.type === StopType.PICKUP);
  const delivery = order.stops.find(s => s.type === StopType.DELIVERY);
  return {
    ...order,
    ...(complete ? serializePackageTotals(order.items.flatMap(i => i.packages)) : { totalWeightG: null, totalVolumeMm3: null }),
    operationalTimezone: 'Asia/Ho_Chi_Minh',
    items: order.items.map(item => ({ ...item, packages: item.packages.map(p => ({
      ...p, weightG: p.weightG.toString(), orderId: order.id,
      pickupStopId: complete ? pickup?.id : null, deliveryStopId: complete ? delivery?.id : null,
    })) })),
  };
}
