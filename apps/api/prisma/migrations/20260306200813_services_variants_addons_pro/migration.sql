-- AlterTable
ALTER TABLE "ServiceAddon" ADD COLUMN     "bufferAfterMin" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bufferBeforeMin" INTEGER NOT NULL DEFAULT 0;
