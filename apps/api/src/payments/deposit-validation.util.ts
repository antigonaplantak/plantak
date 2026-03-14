export function validateDepositPercent(value: number | null): void {
  if (value === null) return;

  if (!Number.isInteger(value)) {
    throw new Error(`Deposit percent must be an integer. Got: ${value}`);
  }

  if (value < 1 || value > 100) {
    throw new Error(`Deposit percent must be between 1 and 100. Got: ${value}`);
  }
}
