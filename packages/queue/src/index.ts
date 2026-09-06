import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

export const queueNames = {
  campaignPlanning: "campaign-planning",
  discovery: "discovery",
  browserFetch: "browser-fetch",
  documentProcessing: "document-processing",
  qwenAnalysis: "qwen-analysis",
  crossValidation: "cross-validation",
  leadScoring: "lead-scoring",
  validation: "validation",
  export: "export"
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export type CampaignJobPayload = {
  campaignId: string;
  priority?: number;
};

export type BrowserResearchPayload = {
  campaignId: string;
  researchJobId?: string;
  leadId?: string;
  companyId?: string;
  url?: string;
  task: "discover_candidates" | "research_company" | "extract_public_profile" | "discover_careers";
  proxyStrategy: "auto" | "direct" | "specific";
  proxyId?: string;
  query?: string;
};

export type AnalysisPayload = {
  campaignId: string;
  researchJobId?: string;
  leadId: string;
  documentIds: string[];
  promptName: string;
  promptVersion: string;
};

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createQueue<T>(name: QueueName, redisUrl: string): Queue<T> {
  return new Queue<T>(name, {
    connection: createRedisConnection(redisUrl),
    defaultJobOptions: defaultJobOptions()
  });
}

export function defaultJobOptions(): JobsOptions {
  return {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000
    },
    removeOnComplete: {
      age: 86400,
      count: 1000
    },
    removeOnFail: {
      age: 604800
    }
  };
}
