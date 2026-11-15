// Types for the generated validator next to this file (scripts/gen-validators.ts). Hand-written, stable.
export interface ValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

export interface Validator {
  (data: unknown): boolean;
  errors: ValidationError[] | null;
}

export declare const auditRequest: Validator;
