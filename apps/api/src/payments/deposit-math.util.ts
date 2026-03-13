export interface DepositAmounts {
  totalCents: number;
  depositCents: number;
  remainingCents: number;
}

function assertMoney(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer in cents. Got: ${value}`);
  }
}

export function calculateDepositAmounts(
  totalCents: number,
  depositPercent: number | null,
): DepositAmounts {
  assertMoney(totalCents, 'totalCents');

  if (depositPercent === null) {
    return {
      totalCents,
      depositCents: 0,
      remainingCents: totalCents,
    };
  }

  if (!Number.isInteger(depositPercent) || depositPercent < 1 || depositPercent > 100) {
    throw new Error(`depositPercent must be an integer between 1 and 100. Got: ${depositPercent}`);
  }

  const depositCents = Math.round((totalCents * depositPercent) / 100);
  const remainingCents = totalCents - depositCents;

  if (depositCents < 0 || depositCents > totalCents) {
    throw new Error(
      `Invalid deposit calculation. depositCents=${depositCents}, totalCents=${totalCents}`,
    );
  }

  return {
    totalCents,
    depositCents,
    remainingCents,
  };
}
