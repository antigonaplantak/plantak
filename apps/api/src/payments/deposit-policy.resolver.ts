import {
  DepositPolicyInput,
  DepositResolvedFrom,
  ResolvedDepositPolicy,
} from './deposit-policy.types';

function normalizePercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  if (!Number.isInteger(value)) {
    throw new Error(`Deposit percent must be an integer. Got: ${value}`);
  }

  if (value < 1 || value > 100) {
    throw new Error(`Deposit percent must be between 1 and 100. Got: ${value}`);
  }

  return value;
}

export function resolveDepositPolicy(
  input: DepositPolicyInput,
): ResolvedDepositPolicy {
  const businessPercent = normalizePercent(input.businessDefaultPercent);
  const servicePercent = normalizePercent(input.serviceDepositPercent);
  const staffPercent = normalizePercent(input.staffDefaultPercent);
  const serviceStaffPercent = normalizePercent(input.serviceStaffDepositPercent);

  let resolvedPercent: number | null = null;
  let resolvedFrom: DepositResolvedFrom = 'none';

  if (input.businessScopeMode === 'ALL_SERVICES' && businessPercent !== null) {
    resolvedPercent = businessPercent;
    resolvedFrom = 'business_default';
  }

  if (!input.serviceUseBusinessDepositDefault) {
    resolvedPercent = servicePercent;
    resolvedFrom = servicePercent === null ? 'none' : 'service_override';
  }

  if (input.staffScopeMode === 'ALL_SERVICES' && staffPercent !== null) {
    resolvedPercent = staffPercent;
    resolvedFrom = 'staff_default';
  }

  if (input.serviceStaffUseStaffDepositDefault === false) {
    resolvedPercent = serviceStaffPercent;
    resolvedFrom =
      serviceStaffPercent === null ? 'none' : 'staff_service_override';
  }

  return {
    percent: resolvedPercent,
    resolvedFrom,
  };
}
