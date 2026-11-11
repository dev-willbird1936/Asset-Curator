declare module "pixelbolt" {
  export function createBundle(spec: Record<string, unknown>): Promise<{ files: Map<string, Buffer>; project: { warnings: string[] }; notes: string[] }>;
}
