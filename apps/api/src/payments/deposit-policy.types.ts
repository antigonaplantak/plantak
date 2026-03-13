export type DepositResolvedFrom =
  | 'none'
  | 'business_default'
  | 'service_override'
  | 'staff_default'
  | 'staff_service_override';

export type DepositServiceScopeMode =
  | 'ALL_SERVICES'
  | 'SELECTED_SERVICES';

export interface DepositPolicyInput {
  businessDefaultPercent: number | null | undefined;
  businessScopeMode: DepositServiceScopeMode;

  serviceUseBusinessDepositDefault: boolean;
  serviceDepositPercent: number | null | undefined;

  staffDefaultPercent?: number | null | undefined;
  staffScopeMode?: DepositServiceScopeMode | null | undefined;

  serviceStaffUseStaffDepositDefault?: boolean | null | undefined;
  serviceStaffDepositPercent?: number | null | undefined;
}

export interface ResolvedDepositPolicy {
  percent: number | null;
  resolvedFrom: DepositResolvedFrom;
}
