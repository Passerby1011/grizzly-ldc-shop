/**
 * 管理台 API 封装。
 *
 * 鉴权改走 **HttpOnly Cookie**（登录后浏览器自动携带）。
 * 原来的做法是把口令放在前端状态里、每个请求塞 Authorization 头 —— 
 * 刷新页面就丢，且口令会长时间留在 JS 内存里。
 * 服务端两种方式都支持（Bearer 留给脚本化调用），后台页面统一用 Cookie。
 */

export interface ApiFailure {
  code: string;
  message: string;
  details?: unknown;
}

export class AdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(failure: ApiFailure, status = 0) {
    super(failure.message);
    this.name = "AdminApiError";
    this.code = failure.code;
    this.status = status;
    this.details = failure.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AdminApiError({ code: "INTERNAL", message: `HTTP ${response.status}` }, response.status);
  }

  const record = payload as { ok?: boolean; data?: T; error?: ApiFailure };
  if (record && record.ok === true) return record.data as T;
  throw new AdminApiError(
    record?.error ?? { code: "INTERNAL", message: `HTTP ${response.status}` },
    response.status,
  );
}

export function adminGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function adminPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export function adminPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
}

/** 登录：成功后 Cookie 由服务端 Set-Cookie 下发。 */
export function adminLogin(token: string): Promise<{ ok: boolean }> {
  return adminPost<{ ok: boolean }>("/api/admin/login", { token });
}

export function adminLogout(): Promise<{ ok: boolean }> {
  return adminPost<{ ok: boolean }>("/api/admin/logout");
}

/**
 * 判断是否已登录：无口令打一个受保护接口。
 * 401 = 未登录；其它错误（配置缺失等）不能误判为未登录，要如实抛出。
 */
export async function checkAdminSession(): Promise<boolean> {
  try {
    await adminGet("/api/admin/settings");
    return true;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) return false;
    throw error;
  }
}

export function adminError(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 触发浏览器下载 CSV（Cookie 自动带上，不需要额外鉴权代码）。 */
export function downloadCsv(type: "keys" | "orders" | "activations" | "ledger"): void {
  const link = document.createElement("a");
  link.href = `/api/admin/export?type=${encodeURIComponent(type)}`;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
