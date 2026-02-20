import OpenAI from "openai";
import { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

export class LlmJsonClient {
  private readonly client: OpenAI | null;
  private readonly model: string;
  private readonly mockMode: boolean;
  private static schemaCounter = 0;

  constructor() {
    this.mockMode = process.env.MOCK_LLM === "1";
    this.model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    this.client = this.mockMode
      ? null
      : new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
          baseURL: process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL
        });
  }

  async completeJson<T>(messages: ChatMessage[], schema: ZodType<T>, fallbackFactory: () => T): Promise<T> {
    if (this.mockMode) {
      return fallbackFactory();
    }

    if (!this.client) {
      return fallbackFactory();
    }

    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required unless MOCK_LLM=1.");
    }

    const schemaName = `structured_output_${LlmJsonClient.schemaCounter++}`;
    const jsonSchema = zodToJsonSchema(schema, {
      name: schemaName
    });

    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName,
            strict: true,
            schema: (jsonSchema.definitions?.[schemaName] ?? jsonSchema) as Record<string, unknown>
          }
        },
        messages
      });
    } catch (error) {
      if (!this.shouldFallbackToJsonObject(error)) {
        throw error;
      }

      completion = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: "json_object" },
        messages
      });
    }

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LLM returned empty JSON response.");
    }

    const parsed = JSON.parse(content);
    return schema.parse(parsed);
  }

  private shouldFallbackToJsonObject(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes("json_schema") ||
      message.includes("response_format") ||
      message.includes("not supported") ||
      message.includes("unsupported")
    );
  }
}
