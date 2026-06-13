export interface StructuredError {
  code: string;
  message: string;
  path?: string;
  tag?: string;
  detail?: Record<string, string>;
  causes?: StructuredError[];
}

export type Result<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: StructuredError;
    };
