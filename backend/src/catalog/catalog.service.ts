import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus, SkuStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreatePriceListDto, SetSkuPriceDto } from './dto/create-price-list.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { QueryCatalogDto } from './dto/query-catalog.dto';

import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  createCategory(dto: CreateCategoryDto) {
    return this.prisma.category.create({ data: { code: dto.code, name: dto.name, description: dto.description, parentId: dto.parentId, displayOrder: dto.displayOrder, active: dto.active } });
  }

  findAllCategories() {
    return this.prisma.category.findMany({ where: { active: true }, include: { children: true }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] });
  }

  createProduct(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        categoryId: dto.categoryId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        brand: dto.brand,
        imageUrl: dto.imageUrl,
        status: dto.status || ProductStatus.DRAFT,
      },
    });
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Không tìm thấy sản phẩm');
    return this.prisma.product.update({
      where: { id },
      data: {
        name: dto.name,
        categoryId: dto.categoryId,
        description: dto.description,
        brand: dto.brand,
        imageUrl: dto.imageUrl,
        status: dto.status,
      },
    });
  }

  async findProductById(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id }, include: { category: true, skus: true } });
    if (!product) throw new NotFoundException('Không tìm thấy sản phẩm');
    return product;
  }

  async createSku(dto: CreateSkuDto) {
    const product = await this.prisma.product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new NotFoundException('Không tìm thấy sản phẩm');
    if (dto.barcodes && new Set(dto.barcodes).size !== dto.barcodes.length) throw new BadRequestException('Barcode bị trùng');
    const barcode = dto.barcodes?.[0];
    if (barcode && await this.prisma.sku.findUnique({ where: { barcode } })) throw new ConflictException('Barcode đã tồn tại');
    const volumeMm3 = BigInt((dto.lengthMm || 0) * (dto.widthMm || 0) * (dto.heightMm || 0));
    return this.prisma.sku.create({ data: { productId: dto.productId, skuCode: dto.skuCode, barcode, name: dto.name, uom: dto.uom, salePrice: new Prisma.Decimal(dto.basePrice || 0), weightGrams: dto.weightGrams, lengthMm: dto.lengthMm, widthMm: dto.widthMm, heightMm: dto.heightMm, volumeMm3, storageCondition: dto.storageCondition, isSellable: dto.isSellable, allowPickup: dto.allowPickup, status: dto.status || SkuStatus.ACTIVE } });
  }

  async queryProducts(query: QueryCatalogDto) {
    const page = query.page || 1, limit = Math.min(query.limit || 20, 100);
    const where: Prisma.ProductWhereInput = { status: ProductStatus.ACTIVE, categoryId: query.categoryId, OR: query.search ? [{ name: { contains: query.search, mode: 'insensitive' } }, { code: { contains: query.search, mode: 'insensitive' } }] : undefined };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({ where, include: { category: true, skus: { where: { status: SkuStatus.ACTIVE } } }, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.product.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  createPriceList(_dto: CreatePriceListDto) {
    throw new BadRequestException('Bản demo dùng một giá trực tiếp trên SKU, không tạo bảng giá riêng');
  }

  async setSkuPrice(dto: SetSkuPriceDto) {
    if (dto.priceListId !== 'DEFAULT') throw new BadRequestException('Bản demo chỉ hỗ trợ priceListId=DEFAULT');
    return this.prisma.sku.update({ where: { id: dto.skuId }, data: { salePrice: new Prisma.Decimal(dto.salePrice ?? dto.basePrice) } });
  }
}
