import { resolveDepositPolicy } from '../src/payments/deposit-policy.resolver';
import { calculateDepositAmounts } from '../src/payments/deposit-math.util';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const businessAll = resolveDepositPolicy({
  businessDefaultPercent: 30,
  businessScopeMode: 'ALL_SERVICES',
  serviceUseBusinessDepositDefault: true,
  serviceDepositPercent: null,
  staffDefaultPercent: null,
  staffScopeMode: 'SELECTED_SERVICES',
  serviceStaffUseStaffDepositDefault: null,
  serviceStaffDepositPercent: null,
});
assert(businessAll.percent === 30, 'business ALL_SERVICES should resolve to 30');
assert(
  businessAll.resolvedFrom === 'business_default',
  'business ALL_SERVICES should resolve from business_default',
);

const serviceOverride = resolveDepositPolicy({
  businessDefaultPercent: 30,
  businessScopeMode: 'ALL_SERVICES',
  serviceUseBusinessDepositDefault: false,
  serviceDepositPercent: 40,
  staffDefaultPercent: null,
  staffScopeMode: 'SELECTED_SERVICES',
  serviceStaffUseStaffDepositDefault: null,
  serviceStaffDepositPercent: null,
});
assert(serviceOverride.percent === 40, 'service override should resolve to 40');
assert(
  serviceOverride.resolvedFrom === 'service_override',
  'service override should resolve from service_override',
);

const staffOverride = resolveDepositPolicy({
  businessDefaultPercent: 30,
  businessScopeMode: 'ALL_SERVICES',
  serviceUseBusinessDepositDefault: false,
  serviceDepositPercent: 40,
  staffDefaultPercent: 25,
  staffScopeMode: 'ALL_SERVICES',
  serviceStaffUseStaffDepositDefault: false,
  serviceStaffDepositPercent: 15,
});
assert(staffOverride.percent === 15, 'staff-service override should resolve to 15');
assert(
  staffOverride.resolvedFrom === 'staff_service_override',
  'staff-service override should resolve from staff_service_override',
);

const amounts = calculateDepositAmounts(10000, 30);
assert(amounts.depositCents === 3000, '30% of 10000 should be 3000');
assert(amounts.remainingCents === 7000, 'remaining should be 7000');

const noDeposit = calculateDepositAmounts(10000, null);
assert(noDeposit.depositCents === 0, 'null deposit should be 0');
assert(noDeposit.remainingCents === 10000, 'null deposit remaining should equal total');

console.log('DEPOSIT_POLICY_SMOKE_OK');
