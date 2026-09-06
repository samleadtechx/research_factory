import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type DocumentArtifactInput = {
  campaignId: string;
  companyId?: string;
  url: string;
  kind: "raw_html" | "clean_text" | "screenshot" | "metadata";
  extension: "html" | "txt" | "png" | "json";
  content: string | Buffer;
};

export type SavedDocumentArtifact = {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
};

export class LocalDocumentStore {
  constructor(private readonly rootDir: string) {}

  async save(input: DocumentArtifactInput): Promise<SavedDocumentArtifact> {
    const id = randomUUID();
    const safeCampaign = sanitizePathSegment(input.campaignId);
    const safeCompany = sanitizePathSegment(input.companyId ?? "unassigned");
    const dir = path.join(this.rootDir, "documents", safeCampaign, safeCompany);
    await mkdir(dir, { recursive: true });

    const filePath = path.join(dir, `${id}.${input.extension}`);
    const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
    await writeFile(filePath, buffer);

    return {
      id,
      path: filePath,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length
    };
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}
