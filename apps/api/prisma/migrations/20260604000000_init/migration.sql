CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "ImagePurpose" AS ENUM ('INPUT', 'MASK', 'GENERATED', 'THUMBNAIL');
CREATE TYPE "ImageStatus" AS ENUM ('PENDING', 'READY', 'ERROR');
CREATE TYPE "TaskStatus" AS ENUM ('RUNNING', 'DONE', 'ERROR');
CREATE TYPE "TaskImageRole" AS ENUM ('INPUT', 'MASK', 'OUTPUT', 'THUMBNAIL');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userAgent" TEXT,
  "ip" TEXT,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TenantMember" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "TenantRole" NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderProfile" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "apiMode" TEXT NOT NULL DEFAULT 'images',
  "apiKeyEncrypted" TEXT,
  "config" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImageAsset" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "sha256" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "purpose" "ImagePurpose" NOT NULL,
  "status" "ImageStatus" NOT NULL DEFAULT 'PENDING',
  "createdByUserId" TEXT NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "params" JSONB NOT NULL,
  "provider" TEXT NOT NULL,
  "status" "TaskStatus" NOT NULL DEFAULT 'RUNNING',
  "error" TEXT,
  "rawResponsePayload" TEXT,
  "rawImageUrls" JSONB,
  "actualParams" JSONB,
  "providerProfileId" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskImage" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "imageAssetId" TEXT NOT NULL,
  "role" "TaskImageRole" NOT NULL,
  "sortIndex" INTEGER NOT NULL DEFAULT 0,
  "providerImageUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE UNIQUE INDEX "TenantMember_tenantId_userId_key" ON "TenantMember"("tenantId", "userId");
CREATE INDEX "TenantMember_userId_idx" ON "TenantMember"("userId");
CREATE INDEX "ProviderProfile_tenantId_idx" ON "ProviderProfile"("tenantId");
CREATE UNIQUE INDEX "ImageAsset_bucket_objectKey_key" ON "ImageAsset"("bucket", "objectKey");
CREATE INDEX "ImageAsset_tenantId_idx" ON "ImageAsset"("tenantId");
CREATE INDEX "ImageAsset_tenantId_status_idx" ON "ImageAsset"("tenantId", "status");
CREATE INDEX "Task_tenantId_createdAt_idx" ON "Task"("tenantId", "createdAt");
CREATE INDEX "Task_tenantId_status_idx" ON "Task"("tenantId", "status");
CREATE INDEX "Task_createdByUserId_idx" ON "Task"("createdByUserId");
CREATE UNIQUE INDEX "TaskImage_taskId_imageAssetId_role_key" ON "TaskImage"("taskId", "imageAssetId", "role");
CREATE INDEX "TaskImage_tenantId_idx" ON "TaskImage"("tenantId");
CREATE INDEX "TaskImage_imageAssetId_idx" ON "TaskImage"("imageAssetId");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderProfile" ADD CONSTRAINT "ProviderProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_providerProfileId_fkey" FOREIGN KEY ("providerProfileId") REFERENCES "ProviderProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskImage" ADD CONSTRAINT "TaskImage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskImage" ADD CONSTRAINT "TaskImage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskImage" ADD CONSTRAINT "TaskImage_imageAssetId_fkey" FOREIGN KEY ("imageAssetId") REFERENCES "ImageAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
