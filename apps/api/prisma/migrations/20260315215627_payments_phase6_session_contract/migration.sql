-- CreateEnum
CREATE TYPE "PaymentSessionStatus" AS ENUM ('OPEN', 'CONSUMED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "PaymentSession" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSessionRef" TEXT,
    "checkoutUrl" TEXT,
    "returnUrl" TEXT,
    "cancelUrl" TEXT,
    "status" "PaymentSessionStatus" NOT NULL DEFAULT 'OPEN',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentSession_bookingId_createdAt_idx" ON "PaymentSession"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentSession_businessId_createdAt_idx" ON "PaymentSession"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentSession_status_expiresAt_idx" ON "PaymentSession"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSession_businessId_idempotencyKey_key" ON "PaymentSession"("businessId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "PaymentSession" ADD CONSTRAINT "PaymentSession_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
