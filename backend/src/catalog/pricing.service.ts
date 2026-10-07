import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}
  async resolveSkuPrice(skuId: string) {
    const sku = await this.prisma.sku.findUnique({ where: { id: skuId } });
    if (!sku) throw new NotFoundException(`Không tìm thấy SKU ${skuId}`);
    return { skuId, priceListId: 'DEFAULT', priceListName: 'Giá bán mặc định', basePrice: Number(sku.salePrice), salePrice: Number(sku.salePrice), effectivePrice: Number(sku.salePrice), vatRate: 0, currency: 'VND' };
  }
  async snapshotPriceForOrderLine(skuId: string, quantity: number) {
    const price = await this.resolveSkuPrice(skuId);
    const unitPrice = new Prisma.Decimal(price.effectivePrice);
    return { skuId, priceListId: 'DEFAULT', unitPrice, vatRate: new Prisma.Decimal(0), vatAmount: new Prisma.Decimal(0), totalWithVat: unitPrice.mul(quantity), currency: 'VND' };
  }
}
