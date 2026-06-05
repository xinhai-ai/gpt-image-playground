DELETE FROM "Session";

ALTER TABLE "User" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "image" TEXT;
ALTER TABLE "User" ALTER COLUMN "passwordHash" SET DEFAULT '';

UPDATE "User"
SET
  "name" = COALESCE(NULLIF(split_part("email", '@', 1), ''), "email"),
  "emailVerified" = true
WHERE "name" = '';

CREATE TABLE "Account" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMP(3),
  "refreshTokenExpiresAt" TIMESTAMP(3),
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
SELECT
  'credential_' || "id",
  "id",
  'credential',
  "id",
  NULLIF("passwordHash", ''),
  "createdAt",
  "updatedAt"
FROM "User"
WHERE NULLIF("passwordHash", '') IS NOT NULL;

INSERT INTO "Account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
SELECT
  'oauth_' || "id",
  "providerAccountId",
  "provider",
  "userId",
  "createdAt",
  "updatedAt"
FROM "OAuthAccount"
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");
CREATE INDEX "Account_userId_idx" ON "Account"("userId");
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "Session_tokenHash_key";
ALTER TABLE "Session" DROP COLUMN "tokenHash";
ALTER TABLE "Session" ADD COLUMN "token" TEXT NOT NULL;
ALTER TABLE "Session" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Session" ADD COLUMN "ipAddress" TEXT;
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

CREATE TABLE "Verification" (
  "id" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");
