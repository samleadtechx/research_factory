-- CreateTable
CREATE TABLE "EnrichmentProvider" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trial',
    "provider" JSONB NOT NULL,
    "supportedDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrichmentProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationProvider" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trial',
    "provider" JSONB NOT NULL,
    "supportedDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailVerificationProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRun" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT,
    "leadId" TEXT,
    "providerType" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerName" TEXT,
    "status" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EnrichmentProvider_name_version_key" ON "EnrichmentProvider"("name", "version");

-- CreateIndex
CREATE INDEX "EnrichmentProvider_status_idx" ON "EnrichmentProvider"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationProvider_name_version_key" ON "EmailVerificationProvider"("name", "version");

-- CreateIndex
CREATE INDEX "EmailVerificationProvider_status_idx" ON "EmailVerificationProvider"("status");

-- CreateIndex
CREATE INDEX "ProviderRun_campaignId_providerType_status_idx" ON "ProviderRun"("campaignId", "providerType", "status");

-- CreateIndex
CREATE INDEX "ProviderRun_providerId_providerType_idx" ON "ProviderRun"("providerId", "providerType");

-- CreateIndex
CREATE INDEX "ProviderRun_leadId_idx" ON "ProviderRun"("leadId");

-- AddForeignKey
ALTER TABLE "EnrichmentProvider" ADD CONSTRAINT "EnrichmentProvider_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationProvider" ADD CONSTRAINT "EmailVerificationProvider_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRun" ADD CONSTRAINT "ProviderRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRun" ADD CONSTRAINT "ProviderRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderRun" ADD CONSTRAINT "ProviderRun_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
