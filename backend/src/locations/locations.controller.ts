import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/branch-scope';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { LocationsService } from './locations.service';

@Controller('locations')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.STAFF, Role.DISPATCHER, Role.DRIVER)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get()
  findMapLocations(@Req() req: { user: AuthenticatedUser }) {
    return this.locationsService.findMapLocations(req.user);
  }
}
