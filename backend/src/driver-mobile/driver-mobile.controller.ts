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
import { DriverMobileService } from "./driver-mobile.service";

@Controller("driver")
export class DriverMobileController {
  constructor(private readonly service: DriverMobileService) {}
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
