export function buildDepositExpiryDate(minutes = 30): Date {
  const now = new Date();
  return new Date(now.getTime() + minutes * 60 * 1000);
}
