-- CreateEnum
CREATE TYPE "PaymentTransactionType" AS ENUM ('PARTIAL_REFUND', 'REFUND', 'FINAL_SETTLEMENT', 'DEPOSIT_FORFEIT', 'DEPOSIT_WAIVE');

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "transactionType" "PaymentTransactionType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentTransaction_bookingId_createdAt_idx" ON "PaymentTransaction"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_businessId_createdAt_idx" ON "PaymentTransaction"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_transactionType_createdAt_idx" ON "PaymentTransaction"("transactionType", "createdAt");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
