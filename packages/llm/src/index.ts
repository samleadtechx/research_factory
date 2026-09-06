import type { ZodSchema } from "zod";

export interface LLMProvider {
  structuredCompletion<T>(params: {
    system?: string;
    prompt: string;
    schema: ZodSchema<T>;
    temperature?: number;
  }): Promise<T>;
}

export type OpenAICompatibleLLMOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
};

export class OpenAICompatibleLLMProvider implements LLMProvider {
  constructor(private readonly options: OpenAICompatibleLLMOptions) {}

  async structuredCompletion<T>(params: {
    system?: string;
    prompt: string;
    schema: ZodSchema<T>;
    temperature?: number;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120000);

    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey ?? "local"}`
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          temperature: params.temperature ?? 0,
          response_format: { type: "json_object" },
          messages: [
            ...(params.system ? [{ role: "system", content: params.system }] : []),
            { role: "user", content: params.prompt }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error("LLM response did not include message content");

      const json = parseJsonObject(content);
      return params.schema.parse(json);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("LLM response was not valid JSON");
  }
}
