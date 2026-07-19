declare module "@huggingface/transformers" {
  export const env: {
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
    cacheDir?: string;
  };

  export function pipeline(task: string, model?: string, options?: Record<string, unknown>): Promise<unknown>;

  export const ModelRegistry: {
    is_pipeline_cached_files(
      task: string,
      model: string,
      options?: Record<string, unknown>
    ): Promise<unknown>;
  };
}
