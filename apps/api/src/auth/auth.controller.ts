import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response, Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/api/auth/refresh',
  };
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.register(dto.email, dto.password);
    res.cookie('rt', (result as any).refreshToken, cookieOptions());
    const { refreshToken, ...rest } = result as any;
    return rest;
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.email, dto.password);
    res.cookie('rt', (result as any).refreshToken, cookieOptions());
    const { refreshToken, ...rest } = result as any;
    return rest;
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Body() dto: RefreshDto, @Res({ passthrough: true }) res: Response) {
    const rtFromCookie = (req as any).cookies?.rt as string | undefined;
    const refreshToken = rtFromCookie || dto.refreshToken;

    const tokens = await this.auth.refresh(refreshToken);
    res.cookie('rt', (tokens as any).refreshToken, cookieOptions());

    const { refreshToken: _rt, ...rest } = tokens as any;
    return rest;
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return req.user;
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  logoutAll(@Req() req: any, @Res({ passthrough: true }) res: Response) {
    res.clearCookie('rt', { path: '/api/auth/refresh' });
    return this.auth.revokeAllSessions(String(req.user.sub));
  }
}
