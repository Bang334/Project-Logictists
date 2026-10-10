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
  PickupPackageDto,
  CompletePickupDto,
  InspectPickupDto,
} from "./driver-mobile.dto";
import { DriverMobileService } from "./driver-mobile.service";
import { DriverExecutionService } from "./driver-execution.service";
import { DriverPickupService } from "./driver-pickup.service";

@Controller("driver")
export class DriverMobileController {
  constructor(private readonly service: DriverMobileService, private readonly execution: DriverExecutionService, private readonly pickup: DriverPickupService) {}
  @Post("assignments/:id/stops/:stopId/scan-pickup")
  @HttpCode(200)
  @RequirePermission("driver.trips.execute")
  inspectPickup(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string,
    @Param("stopId", ParseUUIDPipe) stopId: string, @Body() dto: InspectPickupDto) {
    return this.pickup.run(req.user, id, stopId, undefined, { kind: 'scan', dto });
  }
  @Post("assignments/:id/stops/:stopId/pickup")
  @HttpCode(200)
  @RequirePermission("driver.trips.execute")
  loadPackage(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Headers("idempotency-key") key: string | undefined, @Body() dto: PickupPackageDto) {
    return this.pickup.run(req.user, id, stopId, key, { kind: 'load', dto });
  }
  @Post("assignments/:id/stops/:stopId/complete-pickup")
  @HttpCode(200)
  @RequirePermission("driver.trips.execute")
  completePickup(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Headers("idempotency-key") key: string | undefined, @Body() dto: CompletePickupDto) {
    return this.pickup.run(req.user, id, stopId, key, { kind: 'complete', dto });
  }
  @Post("assignments/:id/start")
  @HttpCode(200)
  @RequirePermission("driver.trips.execute")
  start(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") key: string | undefined, @Body() dto: AssignmentResponseDto) {
    return this.execution.execute(req.user, id, key, dto);
  }
  @Post("assignments/:id/stops/:stopId/arrive")
  @HttpCode(200)
  @RequirePermission("driver.trips.execute")
  arrive(@Req() req: AuthRequest, @Param("id", ParseUUIDPipe) id: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Headers("idempotency-key") key: string | undefined, @Body() dto: AssignmentResponseDto) {
    return this.execution.execute(req.user, id, key, dto, stopId);
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
