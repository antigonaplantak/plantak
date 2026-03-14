import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

type ReqUser = { sub?: string; email?: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: { email: string; password: string }) {
    return this.auth.register(body.email, body.password);
  }

  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.auth.login(body.email, body.password);
  }

  @Post('refresh')
  refresh(@Body() body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: ReqWithUser) {
    return req.user ?? {};
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  logoutAll(@Req() req: ReqWithUser) {
    const userId = String(req.user?.sub ?? '');
    return this.auth.revokeAllSessions(userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('context')
  context(@Req() req: ReqWithUser, @Query('businessId') businessId?: string) {
    const userId = String(req.user?.sub ?? '');
    return this.auth.getContext({
      userId,
      businessId: String(businessId ?? ''),
    });
  }
}
