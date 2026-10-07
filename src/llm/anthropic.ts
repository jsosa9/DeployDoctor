import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { DiagnosisPayload } from "../analyze/payload.js";
import { DiagnosisSchema, type Diagnosis, type LlmProvider } from "./types.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

const MODEL = "claude-opus-5";

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async diagnose(payload: DiagnosisPayload): Promise<Diagnosis> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // Adaptive thinking: correlating a log against a diff and a scope table
      // is exactly the kind of multi-step reasoning this is for.
      thinking: { type: "adaptive" },
      // The system prompt is byte-identical on every invocation, and this is a
      // CLI people run repeatedly, so it's worth a cache breakpoint.
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserMessage(payload) }],
      output_config: { format: zodOutputFormat(DiagnosisSchema) },
    });

    if (!response.parsed_output) {
      throw new Error(
        `The model returned no parseable diagnosis (stop reason: ${response.stop_reason}).`,
      );
    }

    return response.parsed_output;
  }
}
