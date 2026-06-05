ALTER TABLE "ImageAsset" ADD COLUMN "sourceSha256" TEXT;

CREATE INDEX "ImageAsset_tenantId_purpose_sourceSha256_status_idx" ON "ImageAsset"("tenantId", "purpose", "sourceSha256", "status");

DROP INDEX IF EXISTS "TaskImage_taskId_imageAssetId_role_key";

CREATE INDEX "TaskImage_taskId_imageAssetId_role_idx" ON "TaskImage"("taskId", "imageAssetId", "role");
