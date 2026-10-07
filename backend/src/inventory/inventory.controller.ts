import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InventoryService } from './inventory.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import {
  CreateReservationDto,
  CommitReservationDto,
  ReleaseReservationDto,
} from './dto/create-reservation.dto';
import { QueryStockDto } from './dto/query-stock.dto';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  AuthenticatedUser,
  resolveLocationScope,
} from '../auth/branch-scope';

@Controller('inventory')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.STAFF)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // ================= QUERY AVAILABILITY & BALANCES =================
  @Get('balances')
  queryStock(
    @Query() query: QueryStockDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId =
      req.user.role === Role.ADMIN
        ? query.locationId
        : resolveLocationScope(req.user, query.locationId);
    return this.inventoryService.queryStock({ ...query, locationId });
  }

  // ================= RESERVATIONS (CHECKOUT & COMMERCE) =================
  @Post('reservations')
  createReservation(
    @Body() dto: CreateReservationDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, dto.locationId);
    return this.inventoryService.createReservation(
      { ...dto, locationId },
      req.user.id,
      req.user.role === Role.ADMIN ? undefined : locationId,
    );
  }

  @Post('reservations/:id/commit')
  commitReservation(
    @Param('id') id: string,
    @Body() dto: CommitReservationDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.inventoryService.commitReservation(
      id,
      dto,
      req.user.id,
      req.user.role === Role.ADMIN ? undefined : resolveLocationScope(req.user),
    );
  }

  @Post('reservations/:id/release')
  releaseReservation(
    @Param('id') id: string,
    @Body() dto: ReleaseReservationDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.inventoryService.releaseReservation(
      id,
      dto,
      req.user.id,
      req.user.role === Role.ADMIN ? undefined : resolveLocationScope(req.user),
    );
  }

  // ================= RECEIPT & ADJUSTMENT (WAREHOUSE & STORE STAFF) =================
  @Post('receipts')
  createReceipt(
    @Body() dto: CreateReceiptDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, dto.locationId);
    return this.inventoryService.createReceipt({ ...dto, locationId }, req.user.id);
  }

  @Post('adjustments')
  createAdjustment(
    @Body() dto: CreateAdjustmentDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, dto.locationId);
    return this.inventoryService.createAdjustment({ ...dto, locationId }, req.user.id);
  }
}
