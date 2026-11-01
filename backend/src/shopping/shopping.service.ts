import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService } from '../mapbox/mapbox.service';
import { SearchAvailabilityDto } from './dto/search-availability.dto';
import { CheckCartDto } from './dto/check-cart.dto';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { Location, Prisma, SkuStatus } from '@prisma/client';
import { randomUUID } from 'crypto';

export interface SkuAvailabilityResult {
  skuId: string;
  skuCode: string;
  name: string;
  uom: string;
  salePrice: number;
  imageUrl?: string | null;
  productName: string;
  categoryName?: string;
  maxOrderableQuantity: number;
  fulfillmentLabel: 'SINGLE_STORE' | 'MULTI_STORE' | 'UNAVAILABLE';
  canAddToCart: boolean;
}

export interface CartCheckFeasibility {
  isFeasible: boolean;
  sourceCount: number;
  sources: Array<{ id: string; name: string; address: string }>;
  warnings: string[];
  exceedingLines?: Array<{ skuId: string; requestedQuantity: number; availableInZone: number }>;
  suggestedActions?: string[];
}

export interface QuoteResult {
  quoteId: string;
  quoteVersion: number;
  serviceZoneId?: string;
  serviceZoneVersion?: number;
  createdAt: string;
  expiresAt: string;
  provinceCode: string;
  deliveryAddress: string;
  deliveryLatitude: number;
  deliveryLongitude: number;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  items: Array<{
    skuId: string;
    skuCode: string;
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    sourceAllocations: Array<{ locationId: string; locationName: string; quantity: number }>;
  }>;
  subtotal: number;
  shippingFee: number;
  shippingFeeStatus: 'ESTIMATED_PENDING_MEASUREMENT' | 'FIXED';
  totalAmount: number;
  sourceStores: Array<{
    id: string;
    name: string;
    address: string;
    distanceToDeliveryKm: number;
  }>;
  maxDistanceBetweenSourcesKm: number;
  conditionsToAccept: string[];
}

@Injectable()
export class ShoppingService {
  private readonly logger = new Logger(ShoppingService.name);
  private readonly MAX_SOURCES_DEFAULT = 2; // POL-M11
  private readonly MAX_DISTANCE_BETWEEN_SOURCES_KM = 40.0; // POL-M11
  private readonly DEFAULT_STORE_DELIVERY_RADIUS_KM = 100.0; // POL-M01
  private readonly QUOTE_TTL_MINUTES = 15; // POL-M06

  // In-memory quote cache (có thể lưu Redis khi mở rộng)
  private readonly quotesCache = new Map<string, QuoteResult>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapboxService: MapboxService,
  ) {}

  // ================= 1. GET SERVICE AREAS =================
  async getServiceAreas() {
    const zones = await this.prisma.serviceZone.findMany({
      where: { active: true },
      include: {
        provinces: true,
        storeZones: {
          include: {
            location: {
              select: { id: true, code: true, name: true, active: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const activeProvinces: Array<{
      provinceCode: string;
      provinceName: string;
      zoneId: string;
      zoneCode: string;
      zoneName: string;
      activeStoreCount: number;
    }> = [];

    for (const zone of zones) {
      const activeStores = zone.storeZones.filter((sz) => sz.location.active);
      for (const prov of zone.provinces) {
        activeProvinces.push({
          provinceCode: prov.provinceCode,
          provinceName: prov.provinceName,
          zoneId: zone.id,
          zoneCode: zone.code,
          zoneName: zone.name,
          activeStoreCount: activeStores.length,
        });
      }
    }

    return {
      zones: zones.map((z) => ({
        id: z.id,
        code: z.code,
        name: z.name,
        description: z.description,
        provinces: z.provinces.map((p) => ({
          code: p.provinceCode,
          name: p.provinceName,
        })),
      })),
      provinces: activeProvinces,
    };
  }

  // ================= 2. SEARCH AVAILABILITY BY LOCATION =================
  async searchAvailability(dto: SearchAvailabilityDto) {
    const page = dto.page ?? 1;
    const limit = Math.min(dto.limit ?? 20, 100);

    // 1. Xác định tập cửa hàng ứng viên (Candidate STORE locations)
    const candidateStores = await this.findCandidateStores(
      dto.provinceCode,
      dto.provinceName,
      dto.latitude,
      dto.longitude,
    );

    if (candidateStores.length === 0) {
      return {
        data: [],
        total: 0,
        page,
        limit,
        message: 'Khu vực này hiện chưa có cửa hàng nào phục vụ giao hàng tận nơi',
      };
    }

    const storeIds = candidateStores.map((s) => s.id);

    // 2. Tìm danh sách sản phẩm & SKU
    const productWhere: Prisma.ProductWhereInput = {
      status: 'ACTIVE',
      categoryId: dto.categoryId,
      OR: dto.search
        ? [
            { name: { contains: dto.search, mode: 'insensitive' } },
            { code: { contains: dto.search, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const products = await this.prisma.product.findMany({
      where: productWhere,
      include: {
        category: true,
        skus: {
          where: { status: SkuStatus.ACTIVE, isSellable: true },
          include: {
            stockBalances: {
              where: { locationId: { in: storeIds } },
            },
          },
        },
      },
    });

    const evaluatedSkus: SkuAvailabilityResult[] = [];

    for (const prod of products) {
      for (const sku of prod.skus) {
        // Tính tồn khả dụng theo từng STORE
        const storeSellableList: number[] = [];
        for (const storeId of storeIds) {
          const balance = sku.stockBalances.find((b) => b.locationId === storeId);
          if (balance) {
            const sellable = Math.max(
              0,
              balance.onHand - balance.reserved - balance.safetyBuffer,
            );
            if (sellable > 0) {
              storeSellableList.push(sellable);
            }
          }
        }

        // Sắp xếp các cửa hàng theo tồn giảm dần
        storeSellableList.sort((a, b) => b - a);

        // Lấy tổng tồn của tối đa N cửa hàng (POL-M11: tối đa 2 nguồn)
        const topSources = storeSellableList.slice(0, this.MAX_SOURCES_DEFAULT);
        const maxOrderableQuantity = topSources.reduce((sum, qty) => sum + qty, 0);

        let fulfillmentLabel: 'SINGLE_STORE' | 'MULTI_STORE' | 'UNAVAILABLE' =
          'UNAVAILABLE';
        let canAddToCart = false;

        if (maxOrderableQuantity > 0) {
          canAddToCart = true;
          // Nếu chỉ cần 1 cửa hàng là đủ lượng lớn nhất
          if (topSources.length === 1 || topSources[0] === maxOrderableQuantity) {
            fulfillmentLabel = 'SINGLE_STORE';
          } else {
            fulfillmentLabel = 'MULTI_STORE';
          }
        }

        // Lọc theo ngữ cảnh (POL-M12):
        // Nếu không yêu cầu showUnavailable và không có từ khóa tìm kiếm cụ thể: chỉ hiện SKU có hàng
        if (
          dto.showUnavailable ||
          dto.search ||
          maxOrderableQuantity > 0
        ) {
          evaluatedSkus.push({
            skuId: sku.id,
            skuCode: sku.skuCode,
            name: sku.name,
            uom: sku.uom,
            salePrice: Number(sku.salePrice),
            imageUrl: prod.imageUrl,
            productName: prod.name,
            categoryName: prod.category?.name,
            maxOrderableQuantity,
            fulfillmentLabel,
            canAddToCart,
          });
        }
      }
    }

    const total = evaluatedSkus.length;
    const paginatedData = evaluatedSkus.slice((page - 1) * limit, page * limit);

    return {
      data: paginatedData,
      total,
      page,
      limit,
      candidateStoreCount: candidateStores.length,
    };
  }

  // ================= 3. CHECK CART FEASIBILITY =================
  async checkCart(dto: CheckCartDto): Promise<CartCheckFeasibility> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Giỏ hàng trống');
    }

    const candidateStores = await this.findCandidateStores(
      dto.provinceCode,
      undefined,
      dto.latitude,
      dto.longitude,
    );

    if (candidateStores.length === 0) {
      return {
        isFeasible: false,
        sourceCount: 0,
        sources: [],
        warnings: ['Khu vực này hiện chưa có cửa hàng nào phục vụ'],
        suggestedActions: ['Vui lòng chọn khu vực giao hàng khác'],
      };
    }

    const storeIds = candidateStores.map((s) => s.id);
    const skuIds = dto.items.map((i) => i.skuId);

    // Lấy tồn kho của các SKU tại tất cả STORE ứng viên
    const balances = await this.prisma.stockBalance.findMany({
      where: {
        locationId: { in: storeIds },
        skuId: { in: skuIds },
      },
    });

    // Map: skuId -> locationId -> sellable
    const stockMap = new Map<string, Map<string, number>>();
    for (const b of balances) {
      if (!stockMap.has(b.skuId)) {
        stockMap.set(b.skuId, new Map());
      }
      const sellable = Math.max(0, b.onHand - b.reserved - b.safetyBuffer);
      stockMap.get(b.skuId)!.set(b.locationId, sellable);
    }

    // Kiểm tra tổng tồn toàn vùng cho từng dòng
    const exceedingLines: Array<{
      skuId: string;
      requestedQuantity: number;
      availableInZone: number;
    }> = [];

    for (const item of dto.items) {
      const locMap = stockMap.get(item.skuId);
      let totalAvailable = 0;
      if (locMap) {
        for (const qty of locMap.values()) {
          totalAvailable += qty;
        }
      }
      if (totalAvailable < item.quantity) {
        exceedingLines.push({
          skuId: item.skuId,
          requestedQuantity: item.quantity,
          availableInZone: totalAvailable,
        });
      }
    }

    if (exceedingLines.length > 0) {
      return {
        isFeasible: false,
        sourceCount: 0,
        sources: [],
        warnings: ['Một số sản phẩm không đủ tồn kho trong toàn bộ khu vực'],
        exceedingLines,
        suggestedActions: exceedingLines.map(
          (line) =>
            `Giảm số lượng SKU ${line.skuId} xuống tối đa ${line.availableInZone} hoặc bỏ khỏi giỏ`,
        ),
      };
    }

    // THUẬT TOÁN PHÂN NGUỒN SƠ BỘ:
    // Bước 1: Thử 1 STORE đáp ứng đủ trọn vẹn tất cả SKU trong giỏ (POL-M09 Ưu tiên 1)
    for (const store of candidateStores) {
      let storeSatisfiesAll = true;
      for (const item of dto.items) {
        const available = stockMap.get(item.skuId)?.get(store.id) ?? 0;
        if (available < item.quantity) {
          storeSatisfiesAll = false;
          break;
        }
      }
      if (storeSatisfiesAll) {
        return {
          isFeasible: true,
          sourceCount: 1,
          sources: [
            {
              id: store.id,
              name: store.name,
              address: store.address,
            },
          ],
          warnings: [],
        };
      }
    }

    // Bước 2: Thử cặp 2 STORE (POL-M09 Ưu tiên 2 & 3, POL-M11 giới hạn 2 nguồn)
    const validPairs: Array<{
      storeA: Location;
      storeB: Location;
      distanceKm: number;
      isLineSplitting: boolean;
    }> = [];

    for (let i = 0; i < candidateStores.length; i++) {
      for (let j = i + 1; j < candidateStores.length; j++) {
        const storeA = candidateStores[i];
        const storeB = candidateStores[j];

        // Kiểm tra khoảng cách giữa Store A và Store B (POL-M11: <= 40 km)
        const distKm = this.haversineDistanceKm(
          storeA.latitude,
          storeA.longitude,
          storeB.latitude,
          storeB.longitude,
        );

        if (distKm > this.MAX_DISTANCE_BETWEEN_SOURCES_KM) {
          continue; // Vượt khoảng cách giữa các nguồn, loại
        }

        // Kiểm tra cặp (A, B) có đủ tồn cho giỏ không
        let pairSatisfies = true;
        let requiresSplitting = false;

        for (const item of dto.items) {
          const qtyA = stockMap.get(item.skuId)?.get(storeA.id) ?? 0;
          const qtyB = stockMap.get(item.skuId)?.get(storeB.id) ?? 0;
          if (qtyA + qtyB < item.quantity) {
            pairSatisfies = false;
            break;
          }
          if (qtyA < item.quantity && qtyB < item.quantity) {
            requiresSplitting = true;
          }
        }

        if (pairSatisfies) {
          validPairs.push({
            storeA,
            storeB,
            distanceKm: distKm,
            isLineSplitting: requiresSplitting,
          });
        }
      }
    }

    if (validPairs.length > 0) {
      // Sắp xếp ưu tiên: không split dòng trước, rồi tới khoảng cách giữa 2 nguồn nhỏ nhất
      validPairs.sort((p1, p2) => {
        if (p1.isLineSplitting !== p2.isLineSplitting) {
          return p1.isLineSplitting ? 1 : -1;
        }
        return p1.distanceKm - p2.distanceKm;
      });

      const best = validPairs[0];
      return {
        isFeasible: true,
        sourceCount: 2,
        sources: [
          { id: best.storeA.id, name: best.storeA.name, address: best.storeA.address },
          { id: best.storeB.id, name: best.storeB.name, address: best.storeB.address },
        ],
        warnings: [
          'Đơn hàng cần gom từ 2 cửa hàng trong khu vực. Có thể phát sinh chi phí vận chuyển gom hàng.',
        ],
      };
    }

    // Không tìm được phương án trong giới hạn 2 nguồn hoặc khoảng cách giữa nguồn quá xa
    return {
      isFeasible: false,
      sourceCount: 0,
      sources: [],
      warnings: [
        'Không tìm thấy phương án giao hàng hợp lệ trong giới hạn 2 cửa hàng gần nhau (dưới 40km).',
      ],
      suggestedActions: [
        'Giảm bớt số lượng hoặc tách giỏ hàng thành nhiều đơn hàng nhỏ hơn.',
      ],
    };
  }

  // ================= 4. CREATE QUOTE WITH ACCURATE MAPBOX VALIDATION =================
  async createQuote(dto: CreateQuoteDto): Promise<QuoteResult> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Giỏ hàng trống');
    }

    // 1. Kiểm tra tính khả thi
    const feasibility = await this.checkCart({
      provinceCode: dto.provinceCode,
      latitude: dto.deliveryLatitude,
      longitude: dto.deliveryLongitude,
      items: dto.items,
    });

    if (!feasibility.isFeasible || feasibility.sources.length === 0) {
      throw new BadRequestException(
        `Không thể tạo báo giá: ${feasibility.warnings.join('; ')}`,
      );
    }

    // 2. Lấy thông tin giá SKU và tên chi tiết
    const skuIds = dto.items.map((i) => i.skuId);
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: skuIds } },
    });

    const skuMap = new Map(skus.map((s) => [s.id, s]));

    // 3. Phân bổ số lượng cho từng nguồn
    const sourceIds = feasibility.sources.map((s) => s.id);
    const balances = await this.prisma.stockBalance.findMany({
      where: {
        locationId: { in: sourceIds },
        skuId: { in: skuIds },
      },
    });

    let subtotal = 0;
    const quotedItems: QuoteResult['items'] = [];

    for (const item of dto.items) {
      const sku = skuMap.get(item.skuId);
      if (!sku) {
        throw new NotFoundException(`Không tìm thấy SKU ${item.skuId}`);
      }
      const unitPrice = Number(sku.salePrice);
      const lineTotal = unitPrice * item.quantity;
      subtotal += lineTotal;

      let remainingToAllocate = item.quantity;
      const sourceAllocations: Array<{
        locationId: string;
        locationName: string;
        quantity: number;
      }> = [];

      for (const src of feasibility.sources) {
        if (remainingToAllocate <= 0) break;
        const bal = balances.find(
          (b) => b.locationId === src.id && b.skuId === item.skuId,
        );
        const sellable = bal
          ? Math.max(0, bal.onHand - bal.reserved - bal.safetyBuffer)
          : 0;

        if (sellable > 0) {
          const allocQty = Math.min(sellable, remainingToAllocate);
          sourceAllocations.push({
            locationId: src.id,
            locationName: src.name,
            quantity: allocQty,
          });
          remainingToAllocate -= allocQty;
        }
      }

      quotedItems.push({
        skuId: sku.id,
        skuCode: sku.skuCode,
        name: sku.name,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
        sourceAllocations,
      });
    }

    // Lấy thông tin cấu hình ServiceZone (MN28 & POL-M11)
    const zone = await this.prisma.serviceZone.findFirst({
      where: {
        active: true,
        provinces: { some: { provinceCode: dto.provinceCode } },
      },
    });

    const maxDistanceBetweenSourcesKm =
      zone?.maxDistanceBetweenSourcesKm ?? this.MAX_DISTANCE_BETWEEN_SOURCES_KM;

    // 4. Tính toán và xác minh khoảng cách Mapbox đường bộ đến điểm giao (Fix Issue 4 & POL-M01)
    const sourceStoresWithDistance: QuoteResult['sourceStores'] = [];
    for (const src of feasibility.sources) {
      const store = await this.prisma.location.findUnique({
        where: { id: src.id },
      });
      if (store) {
        let roadDistanceKm: number;
        try {
          const route = await this.mapboxService.getRoute([
            [store.longitude, store.latitude],
            [dto.deliveryLongitude, dto.deliveryLatitude],
          ]);
          if (!route || typeof route.distanceKm !== 'number' || route.distanceKm <= 0) {
            throw new BadRequestException(
              `Không tìm thấy tuyến đường bộ hợp lệ từ cửa hàng ${store.name} đến điểm giao hàng`,
            );
          }
          roadDistanceKm = route.distanceKm;
        } catch (err: any) {
          if (err instanceof BadRequestException) throw err;
          throw new BadRequestException(
            `Không thể xác minh khoảng cách đường bộ qua Mapbox cho cửa hàng ${store.name}: ${err.message}`,
          );
        }

        // Thực thi giới hạn ngưỡng đường bộ của từng cửa hàng (POL-M01)
        const storeThresholdKm =
          store.maxDeliveryDistanceKm ?? this.DEFAULT_STORE_DELIVERY_RADIUS_KM;
        if (roadDistanceKm > storeThresholdKm) {
          throw new BadRequestException(
            `Cửa hàng ${store.name} vượt ngưỡng khoảng cách giao hàng đường bộ (${Math.round(roadDistanceKm * 10) / 10} km > ${storeThresholdKm} km)`,
          );
        }

        sourceStoresWithDistance.push({
          id: store.id,
          name: store.name,
          address: store.address,
          distanceToDeliveryKm: Math.round(roadDistanceKm * 10) / 10,
        });
      }
    }

    // Kiểm tra khoảng cách đường bộ giữa hai nguồn nếu đơn cần gom từ 2 cửa hàng (Fix Issue 4 & POL-M11)
    if (feasibility.sources.length === 2) {
      const [srcA, srcB] = feasibility.sources;
      const storeA = await this.prisma.location.findUnique({ where: { id: srcA.id } });
      const storeB = await this.prisma.location.findUnique({ where: { id: srcB.id } });
      if (storeA && storeB) {
        try {
          const routeBetween = await this.mapboxService.getRoute([
            [storeA.longitude, storeA.latitude],
            [storeB.longitude, storeB.latitude],
          ]);
          if (!routeBetween || typeof routeBetween.distanceKm !== 'number' || routeBetween.distanceKm <= 0) {
            throw new BadRequestException(
              `Không tìm thấy tuyến đường bộ giữa hai cửa hàng ${storeA.name} và ${storeB.name}`,
            );
          }
          if (routeBetween.distanceKm > maxDistanceBetweenSourcesKm) {
            throw new BadRequestException(
              `Khoảng cách đường bộ giữa hai nguồn xuất hàng vượt giới hạn cho phép (${Math.round(routeBetween.distanceKm * 10) / 10} km > ${maxDistanceBetweenSourcesKm} km)`,
            );
          }
        } catch (err: any) {
          if (err instanceof BadRequestException) throw err;
          throw new BadRequestException(
            `Không thể xác minh tuyến đường bộ giữa hai cửa hàng ${storeA.name} và ${storeB.name}: ${err.message}`,
          );
        }
      }
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.QUOTE_TTL_MINUTES * 60 * 1000);

    const quoteResult: QuoteResult = {
      quoteId: `QTE-${randomUUID()}`,
      quoteVersion: 1,
      serviceZoneId: zone?.id,
      serviceZoneVersion: zone?.version ?? 1,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      provinceCode: dto.provinceCode,
      deliveryAddress: dto.deliveryAddress,
      deliveryLatitude: dto.deliveryLatitude,
      deliveryLongitude: dto.deliveryLongitude,
      deliveryWindowStart: dto.deliveryWindowStart,
      deliveryWindowEnd: dto.deliveryWindowEnd,
      items: quotedItems,
      subtotal,
      shippingFee: 0,
      shippingFeeStatus: 'ESTIMATED_PENDING_MEASUREMENT',
      totalAmount: subtotal,
      sourceStores: sourceStoresWithDistance,
      maxDistanceBetweenSourcesKm,
      conditionsToAccept: [
        'Tiền hàng được chốt theo báo giá hiện tại.',
        'Hàng sẽ được nhân viên tại từng cửa hàng đóng gói và đo kích thước thực tế.',
        'Phí vận chuyển chính xác sẽ được tính toán sau khi kiện hàng được đo và lộ trình xe được lập.',
        'Báo giá có hiệu lực trong 15 phút. Vui lòng hoàn tất thanh toán/đặt hàng trước thời hạn.',
      ],
    };

    // 5. Lưu báo giá bền vững trong PostgreSQL và cache bộ nhớ (Fix Issue 7 & MN28)
    try {
      if (this.prisma.retailQuote) {
        await this.prisma.retailQuote.create({
          data: {
            id: quoteResult.quoteId,
            quoteVersion: quoteResult.quoteVersion,
            serviceZoneId: quoteResult.serviceZoneId,
            serviceZoneVersion: quoteResult.serviceZoneVersion ?? 1,
            provinceCode: dto.provinceCode,
            deliveryAddress: dto.deliveryAddress,
            deliveryLatitude: dto.deliveryLatitude,
            deliveryLongitude: dto.deliveryLongitude,
            deliveryWindowStart: dto.deliveryWindowStart ? new Date(dto.deliveryWindowStart) : null,
            deliveryWindowEnd: dto.deliveryWindowEnd ? new Date(dto.deliveryWindowEnd) : null,
            subtotal,
            shippingFee: 0,
            totalAmount: subtotal,
            sourceStoreCount: sourceStoresWithDistance.length,
            maxDistanceBetweenSourcesKm,
            payload: quoteResult as any,
            expiresAt,
          },
        });
      }
    } catch (dbErr: any) {
      this.logger.warn(`Lưu RetailQuote vào DB: ${dbErr.message}`);
    }

    this.quotesCache.set(quoteResult.quoteId, quoteResult);

    return quoteResult;
  }

  // Lấy lại báo giá đã lưu theo ID (đọc từ cache hoặc DB bền vững)
  async getQuoteById(quoteId: string): Promise<QuoteResult | undefined> {
    const cached = this.quotesCache.get(quoteId);
    if (cached) return cached;

    try {
      if (this.prisma.retailQuote) {
        const record = await this.prisma.retailQuote.findUnique({
          where: { id: quoteId },
        });
        if (record && record.payload && typeof record.payload === 'object') {
          const quote = record.payload as unknown as QuoteResult;
          this.quotesCache.set(quoteId, quote);
          return quote;
        }
      }
    } catch (err: any) {
      this.logger.warn(`Đọc RetailQuote từ DB: ${err.message}`);
    }
    return undefined;
  }

  // ================= HELPER FUNCTIONS =================
  private async findCandidateStores(
    provinceCode?: string,
    provinceName?: string,
    customerLat?: number,
    customerLng?: number,
  ): Promise<Location[]> {
    // 1. Tìm ServiceZone chứa provinceCode hoặc provinceName
    const zoneProvinces = await this.prisma.serviceZoneProvince.findMany({
      where: {
        OR: [
          provinceCode ? { provinceCode } : undefined,
          provinceName ? { provinceName: { contains: provinceName, mode: 'insensitive' } } : undefined,
        ].filter(Boolean) as Prisma.ServiceZoneProvinceWhereInput[],
        zone: { active: true },
      },
      include: {
        zone: {
          include: {
            storeZones: {
              include: {
                location: true,
              },
            },
          },
        },
      },
    });

    if (zoneProvinces.length === 0) {
      return [];
    }

    // 2. Thu thập các STORE thuộc các zone này
    const storeMap = new Map<string, Location>();

    for (const zp of zoneProvinces) {
      for (const sz of zp.zone.storeZones) {
        const store = sz.location;
        if (store.active && store.type === 'STORE') {
          // Kiểm tra bán kính giao hàng tối đa của cửa hàng (POL-M01)
          const maxRadius =
            sz.maxDeliveryDistanceKm ??
            store.maxDeliveryDistanceKm ??
            this.DEFAULT_STORE_DELIVERY_RADIUS_KM;

          if (customerLat !== undefined && customerLng !== undefined) {
            const distKm = this.haversineDistanceKm(
              customerLat,
              customerLng,
              store.latitude,
              store.longitude,
            );
            if (distKm > maxRadius) {
              continue; // Vượt bán kính giao của chính cửa hàng này
            }
          }

          storeMap.set(store.id, store);
        }
      }
    }

    return Array.from(storeMap.values());
  }

  private haversineDistanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Bán kính trái đất (km)
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}

