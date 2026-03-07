-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorRole" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_actorRole_idx" ON "AuditLog"("actorRole");
