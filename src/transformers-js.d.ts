declare module "@huggingface/transformers" {
  export const env: {
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
  };

  export function pipeline(task: string, model?: string, options?: Record<string, unknown>): Promise<unknown>;
}
