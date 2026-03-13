import { DepositResolvedFrom } from './deposit-policy.types';
import { DepositResolvedFromScope } from '@prisma/client';

export function toPrismaDepositResolvedFromScope(
  value: DepositResolvedFrom,
): DepositResolvedFromScope {
  switch (value) {
    case 'business_default':
      return DepositResolvedFromScope.BUSINESS_DEFAULT;
    case 'service_override':
      return DepositResolvedFromScope.SERVICE_OVERRIDE;
    case 'staff_default':
      return DepositResolvedFromScope.STAFF_DEFAULT;
    case 'staff_service_override':
      return DepositResolvedFromScope.STAFF_SERVICE_OVERRIDE;
    default:
      return DepositResolvedFromScope.NONE;
  }
}
