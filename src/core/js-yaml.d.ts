declare module 'js-yaml' {
  export interface LoadOptions {
    filename?: string;
    json?: boolean;
    schema?: unknown;
  }

  export function load(input: string, options?: LoadOptions): unknown;
}
