const PAYMENT_PROVIDER_SESSION_RULE = {
  requiresProviderSessionRef: true,
} as const;

export const PAYMENT_PROVIDER = {
  STUB: 'stub',
} as const;

export type PaymentProviderName =
  (typeof PAYMENT_PROVIDER)[keyof typeof PAYMENT_PROVIDER];

export const DEFAULT_PAYMENT_PROVIDER: PaymentProviderName =
  PAYMENT_PROVIDER.STUB;

export const PAYMENT_PROVIDER_EVENT = {
  DEPOSIT_AUTHORIZED: 'deposit.authorized',
  DEPOSIT_ACTION_REQUIRED: 'deposit.action_required',
  DEPOSIT_AUTHENTICATION_SUCCEEDED: 'deposit.authentication_succeeded',
  DEPOSIT_AUTHENTICATION_FAILED: 'deposit.authentication_failed',
  DEPOSIT_PAID: 'deposit.paid',
  DEPOSIT_VOIDED: 'deposit.voided',
  DEPOSIT_EXPIRED: 'deposit.expired',
  DEPOSIT_CANCELLED: 'deposit.cancelled',
  DEPOSIT_FAILED: 'deposit.failed',
} as const;

export type PaymentProviderEventType =
  (typeof PAYMENT_PROVIDER_EVENT)[keyof typeof PAYMENT_PROVIDER_EVENT];

export type PaymentProviderEventRule = {
  readonly requiresProviderSessionRef: boolean;
};

const STUB_PROVIDER_EVENT_RULES = {
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHORIZED]: PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_ACTION_REQUIRED]:
    PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHENTICATION_SUCCEEDED]:
    PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_AUTHENTICATION_FAILED]:
    PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_PAID]: PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_VOIDED]: PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_EXPIRED]: PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_CANCELLED]: PAYMENT_PROVIDER_SESSION_RULE,
  [PAYMENT_PROVIDER_EVENT.DEPOSIT_FAILED]: PAYMENT_PROVIDER_SESSION_RULE,
} as const satisfies Record<PaymentProviderEventType, PaymentProviderEventRule>;

export const PAYMENT_PROVIDER_CONTRACT = {
  [PAYMENT_PROVIDER.STUB]: STUB_PROVIDER_EVENT_RULES,
} as const satisfies Record<
  PaymentProviderName,
  Record<PaymentProviderEventType, PaymentProviderEventRule>
>;

export const PAYMENT_PROVIDER_NAMES = Object.freeze(
  Object.values(PAYMENT_PROVIDER),
);

export const PAYMENT_PROVIDER_EVENT_TYPES = Object.freeze(
  Object.values(PAYMENT_PROVIDER_EVENT),
);

const PAYMENT_PROVIDER_NAME_SET = new Set<string>(PAYMENT_PROVIDER_NAMES);

const PAYMENT_PROVIDER_EVENT_TYPE_SET_BY_PROVIDER = {
  [PAYMENT_PROVIDER.STUB]: new Set(
    Object.keys(STUB_PROVIDER_EVENT_RULES) as PaymentProviderEventType[],
  ),
} as const satisfies Record<
  PaymentProviderName,
  ReadonlySet<PaymentProviderEventType>
>;

type PaymentProviderContractInput = {
  provider: unknown;
  eventType: unknown;
};

export type ParsedPaymentProviderContract =
  | {
      ok: true;
      provider: PaymentProviderName;
      eventType: PaymentProviderEventType;
      eventRule: PaymentProviderEventRule;
    }
  | {
      ok: false;
      provider: string;
      eventType: string;
      reason: string;
    };

function normalizeContractValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePaymentProviderName(value: unknown): string {
  return normalizeContractValue(value);
}

export function normalizePaymentProviderEventType(value: unknown): string {
  return normalizeContractValue(value);
}

export function isSupportedPaymentProviderName(
  provider: string,
): provider is PaymentProviderName {
  return PAYMENT_PROVIDER_NAME_SET.has(provider);
}

export function isSupportedPaymentProviderEventType(
  provider: PaymentProviderName,
  eventType: string,
): eventType is PaymentProviderEventType {
  return PAYMENT_PROVIDER_EVENT_TYPE_SET_BY_PROVIDER[provider].has(
    eventType as PaymentProviderEventType,
  );
}

export function getPaymentProviderContractViolation(
  input: PaymentProviderContractInput,
): string | null {
  const contract = parsePaymentProviderContract(input);
  return contract.ok ? null : contract.reason;
}

export function parsePaymentProviderContract(
  input: PaymentProviderContractInput,
): ParsedPaymentProviderContract {
  const provider = normalizePaymentProviderName(input.provider);
  const eventType = normalizePaymentProviderEventType(input.eventType);

  if (!provider) {
    return {
      ok: false,
      provider,
      eventType,
      reason: 'provider is required',
    };
  }

  if (!isSupportedPaymentProviderName(provider)) {
    return {
      ok: false,
      provider,
      eventType,
      reason: `Unsupported provider: ${provider}`,
    };
  }

  if (!eventType) {
    return {
      ok: false,
      provider,
      eventType,
      reason: 'eventType is required',
    };
  }

  if (!isSupportedPaymentProviderEventType(provider, eventType)) {
    return {
      ok: false,
      provider,
      eventType,
      reason: `Unsupported event type: ${eventType}`,
    };
  }

  return {
    ok: true,
    provider,
    eventType,
    eventRule: PAYMENT_PROVIDER_CONTRACT[provider][eventType],
  };
}
