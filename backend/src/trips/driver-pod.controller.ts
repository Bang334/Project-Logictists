import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FileInterceptor } from "@nestjs/platform-express";
import { Role } from "@prisma/client";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { DriverPodService } from "./driver-pod.service";
import { UploadDriverPodDto } from "./dto/driver-pod.dto";

@Controller("driver/trips")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(Role.DRIVER)
export class DriverPodController {
  constructor(private readonly driverPodService: DriverPodService) {}

  @Post(":tripId/stops/:stopId/delivery-attempts/:attemptId/pod")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  upload(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadDriverPodDto,
  ) {
    if (!file) {
      throw new BadRequestException({
        errorCode: "POD_FILE_REQUIRED",
        message: "Cần chọn file bằng chứng giao hàng",
      });
    }
    return this.driverPodService.upload(
      req.user.id,
      tripId,
      stopId,
      attemptId,
      dto,
      file,
    );
  }

  @Get(":tripId/stops/:stopId/delivery-attempts/:attemptId/pod")
  findAll(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
  ) {
    return this.driverPodService.findAll(
      req.user.id,
      tripId,
      stopId,
      attemptId,
    );
  }

  @Get(":tripId/stops/:stopId/delivery-attempts/:attemptId/pod/:podFileId/view")
  view(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Param("attemptId", ParseUUIDPipe) attemptId: string,
    @Param("podFileId", ParseUUIDPipe) podFileId: string,
  ) {
    return this.driverPodService.createViewUrl(
      req.user.id,
      tripId,
      stopId,
      attemptId,
      podFileId,
    );
  }
}
