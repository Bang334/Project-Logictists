import { Body, Controller, Get, HttpCode, Ip, Post, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthRequest, Public, RequirePermission } from './access';
import { LoginDto } from './login.dto';
import { ChangePasswordDto } from './change-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto, @Ip() ip: string) { return this.auth.login(body, ip); }
  @RequirePermission('authenticated')
  @Get('profile')
  profile(@Req() req: AuthRequest) { return this.auth.profile(req.user); }
  @RequirePermission('authenticated')
  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: AuthRequest) { return this.auth.logout(req.user); }
  @RequirePermission('authenticated')
  @Post('change-password')
  @HttpCode(200)
  changePassword(@Req() req: AuthRequest, @Body() body: ChangePasswordDto) { return this.auth.changePassword(req.user, body); }
}
