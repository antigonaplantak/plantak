-- AlterEnum
ALTER TYPE "PaymentSessionStatus" ADD VALUE 'AUTHORIZED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentTransactionType" ADD VALUE 'DEPOSIT_AUTHORIZATION';
ALTER TYPE "PaymentTransactionType" ADD VALUE 'DEPOSIT_VOID';

-- AlterTable
ALTER TABLE "PaymentSession" ADD COLUMN     "authorizedAt" TIMESTAMP(3);
