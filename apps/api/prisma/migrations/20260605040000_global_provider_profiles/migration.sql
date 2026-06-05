ALTER TABLE "ProviderProfile" DROP CONSTRAINT IF EXISTS "ProviderProfile_tenantId_fkey";

ALTER TABLE "ProviderProfile" ALTER COLUMN "tenantId" DROP NOT NULL;

UPDATE "ProviderProfile" SET "tenantId" = NULL WHERE "tenantId" IS NOT NULL;

ALTER TABLE "ProviderProfile" ADD CONSTRAINT "ProviderProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
