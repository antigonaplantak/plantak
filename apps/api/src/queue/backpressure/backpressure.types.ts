export type BackpressureBudgetOptions = {
  policyKey: string;
  maxPerWindow: number;
  windowMs: number;
  maxConcurrent: number;
  acquireTimeoutMs: number;
  maxHoldMs: number;
};

export type BackpressureAcquireResult = {
  leaseId: string;
  attemptId: string;
  acquiredAt: number;
};
