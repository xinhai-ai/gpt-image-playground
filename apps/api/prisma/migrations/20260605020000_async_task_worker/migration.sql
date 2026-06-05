ALTER TABLE "Task" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "workerId" TEXT;
ALTER TABLE "Task" ADD COLUMN "workerStartedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "workerLeaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "Task_status_workerLeaseExpiresAt_idx" ON "Task"("status", "workerLeaseExpiresAt");

ALTER TABLE "TaskImage" ADD COLUMN "actualParams" JSONB;
ALTER TABLE "TaskImage" ADD COLUMN "revisedPrompt" TEXT;
