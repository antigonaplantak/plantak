-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "businessId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_businessId_idx" ON "AuditLog"("businessId");
