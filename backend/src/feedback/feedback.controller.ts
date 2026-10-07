import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/branch-scope';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  AddFeedbackMessageDto,
  CreateFeedbackDto,
  QueryFeedbackDto,
  UpdateFeedbackDto,
} from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';

@Controller('feedback')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  create(@Body() dto: CreateFeedbackDto, @Req() req: { user: AuthenticatedUser }) {
    return this.feedbackService.create(dto, req.user);
  }

  @Get()
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  findAll(@Query() query: QueryFeedbackDto, @Req() req: { user: AuthenticatedUser }) {
    return this.feedbackService.findAll(query, req.user);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  findOne(@Param('id') id: string, @Req() req: { user: AuthenticatedUser }) {
    return this.feedbackService.findOne(id, req.user);
  }

  @Post(':id/messages')
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  addMessage(
    @Param('id') id: string,
    @Body() dto: AddFeedbackMessageDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.feedbackService.addMessage(id, dto, req.user);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.STAFF)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateFeedbackDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.feedbackService.update(id, dto, req.user);
  }
}
