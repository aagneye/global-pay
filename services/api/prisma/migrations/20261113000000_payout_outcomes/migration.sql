-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayoutStatus" ADD VALUE 'UNKNOWN';
ALTER TYPE "PayoutStatus" ADD VALUE 'REVERSED';

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "providerReference" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "unknownSince" TIMESTAMP(3);

-- Existing payouts used the payment ID as their idempotency key; keep it, then require one.
UPDATE "Payout" SET "idempotencyKey" = "paymentId" WHERE "idempotencyKey" IS NULL;
ALTER TABLE "Payout" ALTER COLUMN "idempotencyKey" SET NOT NULL;

-- CreateTable
CREATE TABLE "PayoutEvent" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "providerStatus" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsAction" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutEvent_payoutId_createdAt_idx" ON "PayoutEvent"("payoutId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAction_targetType_targetId_idx" ON "OpsAction"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

