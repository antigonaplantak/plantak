import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

type Tokens = { accessToken: string; refreshToken: string };
type AuthResult = { user: unknown } & Tokens;

type ReqWithUser = Request & { user?: { sub?: string } };

function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/api/auth/refresh',
  };
}

function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  // very small cookie parser: "a=1; rt=XYZ; b=2"
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = (await this.auth.register(
      dto.email,
      dto.password,
    )) as AuthResult;
    res.cookie('rt', result.refreshToken, cookieOptions());
    return { user: result.user, accessToken: result.accessToken };
  }

  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = (await this.auth.login(
      dto.email,
      dto.password,
    )) as AuthResult;
    res.cookie('rt', result.refreshToken, cookieOptions());
    return { user: result.user, accessToken: result.accessToken };
  }

  @Post('refresh')
  async refresh(
    @Headers('cookie') cookieHeader: string | undefined,
    @Body() dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rtFromCookie = readCookie(cookieHeader, 'rt');
    const refreshToken = rtFromCookie ?? dto.refreshToken;

    const tokens = (await this.auth.refresh(refreshToken)) as Tokens;
    res.cookie('rt', tokens.refreshToken, cookieOptions());
    return { accessToken: tokens.accessToken };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: ReqWithUser) {
    return req.user;
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  logoutAll(
    @Req() req: ReqWithUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie('rt', { path: '/api/auth/refresh' });
    return this.auth.revokeAllSessions(String(req.user?.sub ?? ''));
  }
}
