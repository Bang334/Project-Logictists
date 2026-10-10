import { Public } from '../auth/access';
import { Roles } from '../auth/roles.decorator';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CatalogService } from './catalog.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreatePriceListDto, SetSkuPriceDto } from './dto/create-price-list.dto';
import { QueryCatalogDto } from './dto/query-catalog.dto';
import { Role } from '@prisma/client';

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  // ================= PUBLIC ENDPOINTS (CUSTOMER & GUEST) =================
  @Public()
  @Get('products')
  queryProducts(@Query() query: QueryCatalogDto) {
    return this.catalogService.queryProducts(query);
  }

  @Public()
  @Get('products/:id')
  findProductById(@Param('id') id: string) {
    return this.catalogService.findProductById(id);
  }

  @Public()
  @Get('categories')
  findAllCategories() {
    return this.catalogService.findAllCategories();
  }

  // ================= ADMIN / STAFF MANAGEMENT ENDPOINTS =================
  @Post('categories')
  @Roles(Role.ADMIN, Role.STAFF)
  @UseGuards(AuthGuard('jwt'))
  createCategory(
    @Body() dto: CreateCategoryDto,
    @Req() req: { user: { role: Role } },
  ) {
    this.assertStaffOrAdmin(req.user.role);
    return this.catalogService.createCategory(dto);
  }

  @Post('products')
  @Roles(Role.ADMIN, Role.STAFF)
  @UseGuards(AuthGuard('jwt'))
  createProduct(
    @Body() dto: CreateProductDto,
    @Req() req: { user: { role: Role } },
  ) {
    this.assertStaffOrAdmin(req.user.role);
    return this.catalogService.createProduct(dto);
  }

  @Patch('products/:id')
  @Roles(Role.ADMIN, Role.STAFF)
  @UseGuards(AuthGuard('jwt'))
  updateProduct(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: { user: { role: Role } },
  ) {
    this.assertStaffOrAdmin(req.user.role);
    return this.catalogService.updateProduct(id, dto);
  }

  @Post('skus')
  @Roles(Role.ADMIN, Role.STAFF)
  @UseGuards(AuthGuard('jwt'))
  createSku(
    @Body() dto: CreateSkuDto,
    @Req() req: { user: { role: Role } },
  ) {
    this.assertStaffOrAdmin(req.user.role);
    return this.catalogService.createSku(dto);
  }

  @Post('price-lists')
  @Roles(Role.ADMIN, Role.STAFF)
  @UseGuards(AuthGuard('jwt'))
  createPriceList(
    @Body() dto: CreatePriceListDto,
    @Req() req: { user: { role: Role } },
  ) {
    this.assertStaffOrAdmin(req.user.role);
    return this.catalogService.createPriceList(dto);
  }

  @Post('sku-prices')
  @Roles(Role.ADMIN, Role.STAFF)
  @UseGuards(AuthGuard('jwt'))
  setSkuPrice(
    @Body() dto: SetSkuPriceDto,
    @Req() req: { user: { role: Role } },
  ) {
    this.assertStaffOrAdmin(req.user.role);
    return this.catalogService.setSkuPrice(dto);
  }

  /**
   * Kiểm tra quyền quản trị catalog: Chỉ ADMIN hoặc STAFF được phép (4 roles: ADMIN, STAFF, DRIVER, CUSTOMER)
   */
  private assertStaffOrAdmin(role: Role) {
    if (role !== Role.ADMIN && role !== Role.STAFF) {
      throw new ForbiddenException(
        'Bạn không có quyền thực hiện thao tác quản lý danh mục và giá sản phẩm',
      );
    }
  }
}
