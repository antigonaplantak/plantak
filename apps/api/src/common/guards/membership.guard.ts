import { CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';

export class MembershipGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    // TODO (enterprise): enforce business membership:
    // - read businessId from route/body
    // - verify user has membership for that businessId

    return true;
  }
}
