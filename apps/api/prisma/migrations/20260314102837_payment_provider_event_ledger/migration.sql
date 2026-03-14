-- AlterTable
ALTER TABLE "Service" ALTER COLUMN "useBusinessDepositDefault" SET DEFAULT false;

-- AlterTable
ALTER TABLE "ServiceStaff" ALTER COLUMN "useStaffDepositDefault" SET DEFAULT false;

-- CreateTable
CREATE TABLE "PaymentProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "businessId" TEXT,
    "bookingId" TEXT,
    "payload" JSONB NOT NULL,
    "signatureVerifiedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_businessId_createdAt_idx" ON "PaymentProviderEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_bookingId_createdAt_idx" ON "PaymentProviderEvent"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentProviderEvent_processedAt_idx" ON "PaymentProviderEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderEvent_provider_providerEventId_key" ON "PaymentProviderEvent"("provider", "providerEventId");
