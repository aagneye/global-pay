-- CreateEnum
CREATE TYPE "PaymentRequestStatus" AS ENUM ('CREATED', 'SENDER_IDENTIFIED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'EXPIRED', 'DECLINED', 'CANCELLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "nameVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fcmToken" TEXT,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "receiverAddress" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "nameVerified" BOOLEAN NOT NULL,
    "token" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "nonce" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "challengeUsedAt" TIMESTAMP(3),
    "senderId" TEXT,
    "senderAddress" TEXT,
    "senderDeviceId" TEXT,
    "validBefore" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "PaymentRequestStatus" NOT NULL DEFAULT 'CREATED',
    "txHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_publicKey_key" ON "Device"("publicKey");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE INDEX "Device_fcmToken_idx" ON "Device"("fcmToken");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_nonce_key" ON "PaymentRequest"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_challenge_key" ON "PaymentRequest"("challenge");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRequest_txHash_key" ON "PaymentRequest"("txHash");

-- CreateIndex
CREATE INDEX "PaymentRequest_receiverId_createdAt_idx" ON "PaymentRequest"("receiverId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_senderId_status_idx" ON "PaymentRequest"("senderId", "status");

-- CreateIndex
CREATE INDEX "PaymentRequest_status_idx" ON "PaymentRequest"("status");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

