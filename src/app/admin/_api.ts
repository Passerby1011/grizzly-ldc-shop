/** 管理台 API 封装：口令放请求头，不放 URL。 */

export interface ApiFailure {
  code: string;
  message: string;
  details?: unknown;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = "AdminApiError";
    this.code = failure.code;
    this.details = failure.details;
  }
}

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AdminApiError({ code: "INTERNAL", message: `HTTP ${response.status}` });
  }
  const record = payload as { ok?: boolean; data?: T; error?: ApiFailure };
  if (record && record.ok === true) return record.data as T;
  throw new AdminApiError(record?.error ?? { code: "INTERNAL", message: `HTTP ${response.status}` });
}

export function adminGet<T>(token: string, path: string): Promise<T> {
  return request<T>(token, path);
}

export function adminPost<T>(token: string, path: string, body?: unknown): Promise<T> {
  return request<T>(token, path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function adminError(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
