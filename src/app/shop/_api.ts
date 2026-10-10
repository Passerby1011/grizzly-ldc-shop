/** 前端调用本站 API 的小工具：统一解包 `{ok, data|error}`。 */

export interface ApiFailure {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiCallError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = "ApiCallError";
    this.code = failure.code;
    this.details = failure.details;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  return unwrap<T>(response);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return unwrap<T>(response);
}

async function unwrap<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiCallError({ code: "INTERNAL", message: `HTTP ${response.status}` });
  }
  const record = payload as { ok?: boolean; data?: T; error?: ApiFailure };
  if (record && record.ok === true) return record.data as T;
  const failure = record?.error ?? { code: "INTERNAL", message: `HTTP ${response.status}` };
  throw new ApiCallError(failure);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiCallError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
