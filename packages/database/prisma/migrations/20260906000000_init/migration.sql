-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'planning', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ProxyProtocol" AS ENUM ('http', 'https', 'socks5');

-- CreateEnum
CREATE TYPE "ProxyStatus" AS ENUM ('untested', 'healthy', 'degraded', 'cooldown', 'quarantined');

-- CreateEnum
CREATE TYPE "RetrievalMethod" AS ENUM ('browser', 'camoufox', 'http', 'api', 'manual');

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL DEFAULT 'v1',
    "status" "CampaignStatus" NOT NULL DEFAULT 'planning',
    "plan" JSONB,
    "settings" JSONB,
    "targetLeadCount" INTEGER,
    "serverUsagePercent" INTEGER,
    "progress" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchJob" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "parameters" JSONB NOT NULL,
    "statistics" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "normalizedName" TEXT,
    "domain" TEXT,
    "website" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "phone" TEXT,
    "generalEmail" TEXT,
    "emails" JSONB,
    "owners" JSONB,
    "managers" JSONB,
    "metadata" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "score" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "strongestSignal" TEXT,
    "scoreComponents" JSONB,
    "disqualified" BOOLEAN NOT NULL DEFAULT false,
    "disqualificationReason" TEXT,
    "rank" INTEGER,
    "exportSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT,
    "sourceType" TEXT NOT NULL,
    "retrievalMethod" "RetrievalMethod" NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "finalUrl" TEXT,
    "httpStatus" INTEGER,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT,
    "rawHtmlPath" TEXT,
    "cleanTextPath" TEXT,
    "screenshotPath" TEXT,
    "title" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT,
    "leadId" TEXT,
    "documentId" TEXT,
    "field" TEXT,
    "sourceType" TEXT NOT NULL,
    "retrievalMethod" "RetrievalMethod" NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "quote" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT,
    "leadId" TEXT,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceIds" TEXT[],
    "promptName" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proxy" (
    "id" TEXT NOT NULL,
    "protocol" "ProxyProtocol" NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "passwordEncrypted" TEXT,
    "label" TEXT,
    "status" "ProxyStatus" NOT NULL DEFAULT 'untested',
    "successes" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "averageLatencyMs" INTEGER,
    "lastUsedAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proxy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceFailure" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT,
    "leadId" TEXT,
    "url" TEXT NOT NULL,
    "sourceName" TEXT,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRecipe" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trial',
    "recipe" JSONB NOT NULL,
    "supportedDomains" TEXT[],
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchJob_campaignId_status_idx" ON "ResearchJob"("campaignId", "status");

-- CreateIndex
CREATE INDEX "ResearchJob_type_status_priority_idx" ON "ResearchJob"("type", "status", "priority");

-- CreateIndex
CREATE INDEX "Company_domain_idx" ON "Company"("domain");

-- CreateIndex
CREATE INDEX "Company_phone_idx" ON "Company"("phone");

-- CreateIndex
CREATE INDEX "Company_normalizedName_city_state_idx" ON "Company"("normalizedName", "city", "state");

-- CreateIndex
CREATE INDEX "Lead_campaignId_score_idx" ON "Lead"("campaignId", "score");

-- CreateIndex
CREATE INDEX "Lead_campaignId_rank_idx" ON "Lead"("campaignId", "rank");

-- CreateIndex
CREATE INDEX "Lead_companyId_idx" ON "Lead"("companyId");

-- CreateIndex
CREATE INDEX "Document_campaignId_retrievedAt_idx" ON "Document"("campaignId", "retrievedAt");

-- CreateIndex
CREATE INDEX "Document_companyId_idx" ON "Document"("companyId");

-- CreateIndex
CREATE INDEX "Document_contentHash_idx" ON "Document"("contentHash");

-- CreateIndex
CREATE INDEX "Document_url_idx" ON "Document"("url");

-- CreateIndex
CREATE INDEX "Evidence_campaignId_field_idx" ON "Evidence"("campaignId", "field");

-- CreateIndex
CREATE INDEX "Evidence_companyId_idx" ON "Evidence"("companyId");

-- CreateIndex
CREATE INDEX "Evidence_leadId_idx" ON "Evidence"("leadId");

-- CreateIndex
CREATE INDEX "Evidence_documentId_idx" ON "Evidence"("documentId");

-- CreateIndex
CREATE INDEX "Claim_campaignId_field_idx" ON "Claim"("campaignId", "field");

-- CreateIndex
CREATE INDEX "Claim_companyId_field_idx" ON "Claim"("companyId", "field");

-- CreateIndex
CREATE INDEX "Claim_leadId_field_idx" ON "Claim"("leadId", "field");

-- CreateIndex
CREATE INDEX "Proxy_status_healthScore_idx" ON "Proxy"("status", "healthScore");

-- CreateIndex
CREATE UNIQUE INDEX "Proxy_protocol_host_port_username_key" ON "Proxy"("protocol", "host", "port", "username");

-- CreateIndex
CREATE INDEX "SourceFailure_campaignId_blocked_idx" ON "SourceFailure"("campaignId", "blocked");

-- CreateIndex
CREATE INDEX "SourceFailure_url_idx" ON "SourceFailure"("url");

-- CreateIndex
CREATE INDEX "SourceRecipe_status_idx" ON "SourceRecipe"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRecipe_name_version_key" ON "SourceRecipe"("name", "version");

-- CreateIndex
CREATE INDEX "CampaignEvent_campaignId_createdAt_idx" ON "CampaignEvent"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceFailure" ADD CONSTRAINT "SourceFailure_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRecipe" ADD CONSTRAINT "SourceRecipe_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvent" ADD CONSTRAINT "CampaignEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
