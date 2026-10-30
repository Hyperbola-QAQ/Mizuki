declare module "@utils/markdown-processor.mjs" {
  export const runtimeMarkdownProcessor: {
    createRenderer(options?: Record<string, unknown>): Promise<{
      render(body: string, options?: { frontmatter?: Record<string, unknown> }): Promise<{
        code: string;
        metadata: Record<string, unknown>;
      }>;
    }>;
  };
}
