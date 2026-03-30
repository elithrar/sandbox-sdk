// Copied from https://github.com/cloudflare/playwright/blob/main/packages/playwright-cloudflare/examples/stagehand/src/worker/workersAIClient.ts
import type {
  CreateChatCompletionOptions,
  LogLine
} from '@browserbasehq/stagehand';
import { LLMClient } from '@browserbasehq/stagehand';
import zodToJsonSchema from 'zod-to-json-schema';

type WorkersAIOptions = AiOptions & {
  logger?: (line: LogLine) => void;
};

const modelId = '@cf/moonshotai/kimi-k2.5';

export class WorkersAIClient extends LLMClient {
  public type = 'workers-ai' as const;
  #binding: Ai;
  #options?: WorkersAIOptions;

  constructor(binding: Ai, options?: WorkersAIOptions) {
    super(modelId);
    this.#binding = binding;
    this.#options = options;
  }

  async createChatCompletion<T>({
    options
  }: CreateChatCompletionOptions): Promise<T> {
    const schema = options.response_model?.schema;
    this.#options?.logger?.({ category: 'workersai', message: 'thinking...' });

    const { response } = (await this.#binding.run(
      this.modelName as keyof AiModels,
      {
        messages: options.messages as unknown as { role: string; content: string }[],
        // @ts-ignore — tools not in the base type but accepted at runtime
        tools: options.tools,
        response_format: schema
          ? { type: 'json_schema', json_schema: zodToJsonSchema(schema) }
          : undefined,
        temperature: 0
      },
      this.#options
    )) as AiTextGenerationOutput;

    this.#options?.logger?.({
      category: 'workersai',
      message: 'completed thinking!'
    });

    return { data: response } as T;
  }
}
