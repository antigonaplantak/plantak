import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { MagicAuthService } from './magic-auth.service';
import { AuthService } from './auth.service';

@Controller('auth/magic')
export class MagicAuthController {
  constructor(
    private readonly magic: MagicAuthService,
    private readonly auth: AuthService,
  ) {}

  @Post('request')
  async request(@Req() req: Request, @Body() body: { email: string }) {
    return this.magic.requestLoginCode({
      email: body.email,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('verify')
  async verify(
    @Req() req: Request,
    @Body() body: { email: string; code: string },
  ) {
    const user = await this.magic.verifyLoginCode({
      email: body.email,
      code: body.code,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return this.auth.issueTokensForUser(user.id);
  }
}
