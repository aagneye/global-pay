-- CreateEnum
CREATE TYPE "OnrampStatus" AS ENUM ('CREATED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "OnrampOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "fiatAmount" BIGINT NOT NULL,
    "status" "OnrampStatus" NOT NULL DEFAULT 'CREATED',
    "providerTxId" TEXT,
    "providerStatus" TEXT,
    "expectedTokenAmount" BIGINT,
    "txHash" TEXT,
    "logIndex" INTEGER,
    "receivedAmount" BIGINT,
    "failureReason" TEXT,
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnrampOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnrampOrder_userId_createdAt_idx" ON "OnrampOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "OnrampOrder_status_idx" ON "OnrampOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OnrampOrder_txHash_logIndex_key" ON "OnrampOrder"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Deposit_userId_createdAt_idx" ON "Deposit"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_chainId_txHash_logIndex_key" ON "Deposit"("chainId", "txHash", "logIndex");

-- AddForeignKey
ALTER TABLE "OnrampOrder" ADD CONSTRAINT "OnrampOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

