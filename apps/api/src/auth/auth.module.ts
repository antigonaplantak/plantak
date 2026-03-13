import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthContextController } from './auth-context.controller';
import { JwtStrategy } from './jwt.strategy';
import { MagicAuthService } from './magic-auth.service';
import { MagicAuthController } from './magic-auth.controller';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}), // secrets i marrim te AuthService (sign)
  ],
  providers: [AuthService, JwtStrategy, MagicAuthService],
  controllers: [AuthController, MagicAuthController, AuthContextController],
  exports: [AuthService],
})
export class AuthModule {}
