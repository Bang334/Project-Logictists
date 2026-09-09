import { Controller, Get, Post, Body, Param, Query, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TripsService } from './trips.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { TripStatus } from '@prisma/client';

@Controller('trips')
@UseGuards(AuthGuard('jwt'))
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Get()
  findAll(@Query('status') status?: TripStatus) {
    return this.tripsService.findAll(status);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tripsService.findOne(id);
  }

  @Get(':id/load-profile')
  getLoadProfile(@Param('id') id: string) {
    return this.tripsService.getLoadProfile(id);
  }

  @Post()
  create(@Body() createTripDto: CreateTripDto) {
    return this.tripsService.create(createTripDto);
  }

  @Patch(':id/publish')
  publish(@Param('id') id: string) {
    return this.tripsService.publish(id);
  }
}
