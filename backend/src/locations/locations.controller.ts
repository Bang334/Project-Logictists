import { Controller, Get, Req } from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { LocationsService } from './locations.service';

@Controller('locations')
@RequirePermission('branches.read')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get()
  findMapLocations(@Req() req: AuthRequest) {
    return this.locationsService.findMapLocations(req.user);
  }
}
