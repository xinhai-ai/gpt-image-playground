ALTER TABLE "User" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "disabledAt" TIMESTAMP(3);

ALTER TABLE "ProviderProfile" ADD COLUMN "disabledAt" TIMESTAMP(3);

CREATE TABLE "UsageLog" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "targetType" TEXT,
  "targetId" TEXT,
  "detail" JSONB,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UsageLog_createdAt_idx" ON "UsageLog"("createdAt");
CREATE INDEX "UsageLog_userId_createdAt_idx" ON "UsageLog"("userId", "createdAt");
CREATE INDEX "UsageLog_tenantId_createdAt_idx" ON "UsageLog"("tenantId", "createdAt");
CREATE INDEX "UsageLog_action_createdAt_idx" ON "UsageLog"("action", "createdAt");

ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UsageLog" ADD CONSTRAINT "UsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
