import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { AuthRequest, RequirePermission } from "../auth/access";
import {
  AssignmentQuery,
  AssignmentResponseDto,
  RejectAssignmentDto,
} from "./driver-mobile.dto";
import { DriverContinuationService } from "./driver-continuation.service";
import {
  ConfirmTaskDto,
  EnhancedFailedDeliveryDto,
  ReturnToHubDto,
} from "./driver-execution.dto";
import { DriverMobileService } from "./driver-mobile.service";

@Controller("driver")
export class DriverMobileController {
  constructor(
    private readonly service: DriverMobileService,
    private readonly continuation: DriverContinuationService,
  ) {}
  @Post("assignments/:id/tasks/:taskId/pickup-confirm")
  @HttpCode(200)
  @RequirePermission("driver.assignments.respond")
  confirmPickup(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: ConfirmTaskDto,
  ) {
    return this.continuation.confirmPickupTask(req.user, id, taskId, key, dto);
  }
  @Post("assignments/:id/tasks/:taskId/delivery-confirm")
  @HttpCode(200)
  @RequirePermission("driver.assignments.respond")
  confirmDelivery(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: ConfirmTaskDto,
  ) {
    return this.continuation.confirmDeliveryTask(req.user, id, taskId, key, dto);
  }
  @Post("assignments/:id/tasks/:taskId/delivery-failure")
  @HttpCode(200)
  @RequirePermission("driver.assignments.respond")
  reportDeliveryFailure(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: EnhancedFailedDeliveryDto,
  ) {
    return this.continuation.reportDeliveryFailure(req.user, id, taskId, key, dto);
  }
  @Post("assignments/:id/stops/:stopId/return-to-hub")
  @HttpCode(200)
  @RequirePermission("driver.assignments.respond")
  returnToHub(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: ReturnToHubDto,
  ) {
    return this.continuation.confirmReturnToHub(req.user, id, stopId, key, dto);
  }
  @Get("me")
  @RequirePermission("driver.profile.read")
  me(@Req() req: AuthRequest) {
    return this.service.me(req.user);
  }
  @Get("assignments")
  @RequirePermission("driver.assignments.read")
  list(@Req() req: AuthRequest, @Query() query: AssignmentQuery) {
    return this.service.list(req.user, query);
  }
  @Get("assignments/:id")
  @RequirePermission("driver.assignments.read")
  detail(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.detail(req.user, id);
  }
  @Post("assignments/:id/accept")
  @HttpCode(200)
  @RequirePermission("driver.assignments.respond")
  accept(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: AssignmentResponseDto,
  ) {
    return this.service.respond(req.user, id, key, dto, "ACCEPTED");
  }
  @Post("assignments/:id/reject")
  @HttpCode(200)
  @RequirePermission("driver.assignments.respond")
  reject(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: RejectAssignmentDto,
  ) {
    return this.service.respond(req.user, id, key, dto, "REJECTED", dto.reason);
  }
}
