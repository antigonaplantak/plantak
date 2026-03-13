-- CreateTable
CREATE TABLE "RuntimeLease" (
    "leaseKey" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "fencingToken" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuntimeLease_pkey" PRIMARY KEY ("leaseKey")
);

-- CreateIndex
CREATE INDEX "RuntimeLease_expiresAt_idx" ON "RuntimeLease"("expiresAt");
