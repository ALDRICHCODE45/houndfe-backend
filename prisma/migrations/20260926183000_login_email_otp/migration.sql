-- Additive, global authentication state. users.id is TEXT, not UUID.
CREATE TYPE "LoginOtpState" AS ENUM ('PENDING', 'ACTIVE', 'CONSUMED', 'FAILED');

CREATE TABLE "login_otp_challenges" (
    "userId" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "handleHash" CHAR(64) NOT NULL,
    "codeMac" CHAR(64) NOT NULL,
    "state" "LoginOtpState" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "login_otp_challenges_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "login_otp_challenges_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "login_otp_challenges_handleHash_key" ON "login_otp_challenges"("handleHash");
CREATE INDEX "login_otp_challenges_expiresAt_idx" ON "login_otp_challenges"("expiresAt");

CREATE TABLE "auth_rate_buckets" (
    "key" CHAR(64) NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auth_rate_buckets_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "auth_rate_buckets_windowStart_idx" ON "auth_rate_buckets"("windowStart");
