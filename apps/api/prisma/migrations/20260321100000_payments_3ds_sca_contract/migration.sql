ALTER TYPE "PaymentSessionStatus" ADD VALUE 'ACTION_REQUIRED';

ALTER TABLE "PaymentSession"
  ADD COLUMN "challengeUrl" TEXT,
  ADD COLUMN "actionRequiredAt" TIMESTAMP(3);
