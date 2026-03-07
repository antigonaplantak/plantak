-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyKey_businessId_action_createdAt_idx" ON "IdempotencyKey"("businessId", "action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_businessId_key_key" ON "IdempotencyKey"("businessId", "key");
