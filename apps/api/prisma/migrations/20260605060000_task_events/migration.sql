CREATE TABLE "TaskEvent" (
  "id" BIGSERIAL NOT NULL,
  "tenantId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskEvent_tenantId_id_idx" ON "TaskEvent"("tenantId", "id");
CREATE INDEX "TaskEvent_taskId_idx" ON "TaskEvent"("taskId");
CREATE INDEX "TaskEvent_createdAt_idx" ON "TaskEvent"("createdAt");

ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
