/**
 * LINUX DO Credit（易支付兼容协议）客户端。
 *
 * 上游事实（2026-10-10 实测，勿改）：
 * - 基址 `https://credit.linux.do/epay`
 * - 签名：取**所有非空**请求参数，**排除 `sign`、`sign_type`**，按参数名 ASCII 升序拼
 *   `k1=v1&k2=v2`，末尾**直接追加** `LDC_KEY`，整体 **MD5 取小写十六进制**。
 * - 下单 `POST /epay/pay/submit.php`（form-urlencoded）成功 → **302 跳转**
 *   `https://credit.linux.do/paying?order_no=...`；`sign` 错误时返回 **HTTP 401**。
 * - 查询 `GET /epay/api.php?act=order&pid=&key=&out_trade_no=`；订单不存在 → **HTTP 404**
 *   + `{"code":-1,"msg":"订单不存在或已完成"}`。
 * - 退款 `POST /epay/api.php` `{pid, key, trade_no, money}`，仅支持全额退回已成功订单。
 * - 异步通知 **HTTP GET** 到 `notify_url`，必须返回 HTTP 200 且响应体为 `success`。
 */
import { createHash } from "node:crypto";
import { dec, type Decimal, type DecimalInput } from "./money";
import { getConfig } from "./config";
import { constantTimeEqual } from "./keycodec";

export const LDC_NOTIFY_SUCCESS = "success";
export const LDC_SIGN_TYPE = "MD5";
/** 上游对 `name` 的长度限制。 */
export const LDC_NAME_MAX_LENGTH = 64;

export type ParamMap = Record<string, string | number | null | undefined>;

export class LdcApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code: number | null;

  constructor(message: string, status: number, body: string, code: number | null = null) {
    super(message);
    this.name = "LdcApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

function md5Lower(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex").toLowerCase();
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}

/** 参与签名的参数：排除 sign / sign_type，剔除空值，按参数名 ASCII 升序。 */
export function canonicalizeParams(params: ParamMap): Array<[string, string]> {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && !isBlank(value))
    .map(([key, value]) => [key, String(value)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 拼签名原文（不含密钥）。 */
export function buildSignPayload(params: ParamMap): string {
  return canonicalizeParams(params)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** 易支付签名：`md5(payload + LDC_KEY)` 小写十六进制。 */
export function epaySign(params: ParamMap, key: string): string {
  return md5Lower(buildSignPayload(params) + key);
}

/** 验签（常量时间比较）。 */
export function verifyEpaySign(params: ParamMap, key: string): boolean {
  const provided = params.sign;
  if (isBlank(provided)) return false;
  const expected = epaySign(params, key);
  return constantTimeEqual(String(provided).toLowerCase(), expected);
}

/** 补齐 `sign` 与 `sign_type=MD5`。 */
export function signParams(params: ParamMap, key: string): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of canonicalizeParams(params)) clean[name] = value;
  clean.sign = epaySign(params, key);
  clean.sign_type = LDC_SIGN_TYPE;
  return clean;
}

export function isTradeSuccess(params: ParamMap): boolean {
  const status = params.trade_status;
  return typeof status === "string" && status.trim().toUpperCase() === "TRADE_SUCCESS";
}

export interface LdcClientOptions {
  pid: string;
  key: string;
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export interface CreateOrderInput {
  outTradeNo: string;
  name: string;
  money: DecimalInput;
  notifyUrl?: string;
  returnUrl?: string;
}

export interface CreateOrderResult {
  payUrl: string;
  orderNo: string | null;
}

export interface QueryOrderResult {
  found: boolean;
  paid: boolean;
  status: number | null;
  tradeNo: string | null;
  raw: unknown;
}

export interface RefundResult {
  ok: boolean;
  raw: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LdcClient {
  private readonly pid: string;
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LdcClientOptions) {
    this.pid = options.pid;
    this.key = options.key;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.retries = Math.max(1, options.retries ?? 2);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 下单：成功返回收银台跳转 URL。 */
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const name = input.name.length > LDC_NAME_MAX_LENGTH ? input.name.slice(0, LDC_NAME_MAX_LENGTH) : input.name;
    const money = dec(input.money).toFixed(2);
    const params: ParamMap = {
      pid: this.pid,
      type: "epay",
      out_trade_no: input.outTradeNo,
      name,
      money,
      notify_url: input.notifyUrl,
      return_url: input.returnUrl,
    };
    const body = new URLSearchParams(signParams(params, this.key)).toString();
    const url = `${this.baseUrl}/pay/submit.php`;
    let lastError: unknown = new LdcApiError("未发起请求", 0, "");
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "text/html, application/json",
          },
          body,
        });
        const text = await response.text();
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          return { payUrl: new URL(location, this.baseUrl).toString(), orderNo: extractOrderNo(location) };
        }
        if (response.status === 401) {
          throw new LdcApiError("LDC 下单失败：签名被拒（HTTP 401）", 401, text);
        }
        if (response.status >= 500 && attempt < this.retries) {
          lastError = new LdcApiError(`LDC 下单失败：HTTP ${response.status}`, response.status, text);
        } else {
          throw new LdcApiError(`LDC 下单失败：HTTP ${response.status}`, response.status, text, parseCode(text));
        }
      } catch (error) {
        if (error instanceof LdcApiError && error.status > 0 && error.status < 500) throw error;
        lastError = error;
        if (attempt >= this.retries) break;
      }
      await sleep(150 * attempt);
    }
    if (lastError instanceof Error) throw lastError;
    throw new LdcApiError(String(lastError), 0, "");
  }

  /** 主动查询订单：404 视为「订单不存在」，不抛错。 */
  async queryOrder(outTradeNo: string): Promise<QueryOrderResult> {
    const url = new URL(`${this.baseUrl}/api.php`);
    url.searchParams.set("act", "order");
    url.searchParams.set("pid", this.pid);
    url.searchParams.set("key", this.key);
    url.searchParams.set("out_trade_no", outTradeNo);
    const response = await this.fetchWithTimeout(url.toString(), {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    const json = safeJson(text);
    if (response.status === 404) {
      return { found: false, paid: false, status: null, tradeNo: null, raw: json ?? text };
    }
    if (!response.ok) {
      throw new LdcApiError(`LDC 查询失败：HTTP ${response.status}`, response.status, text, parseCode(text));
    }
    const record = asRecord(json);
    if (!record) {
      throw new LdcApiError("LDC 查询返回非 JSON", response.status, text);
    }
    const code = asNumber(record.code);
    if (code === -1) {
      return { found: false, paid: false, status: null, tradeNo: null, raw: json };
    }
    const status = asNumber(record.status);
    return {
      found: true,
      paid: status === 1,
      status,
      tradeNo: typeof record.trade_no === "string" ? record.trade_no : null,
      raw: json,
    };
  }

  /** 全额退款：`money` 必须等于原额。 */
  async refund(tradeNo: string, money: DecimalInput): Promise<RefundResult> {
    const body = new URLSearchParams({
      pid: this.pid,
      key: this.key,
      trade_no: tradeNo,
      money: dec(money).toFixed(2),
    }).toString();
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api.php`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    const text = await response.text();
    const json = safeJson(text);
    if (!response.ok) {
      throw new LdcApiError(`LDC 退款失败：HTTP ${response.status}`, response.status, text, parseCode(text));
    }
    const record = asRecord(json);
    const code = record ? asNumber(record.code) : null;
    return { ok: code === 1, raw: json ?? text };
  }
}

/** 从 302 Location 里提取 `order_no`（拿不到返回 null）。 */
export function extractOrderNo(location: string): string | null {
  try {
    const url = new URL(location, "https://credit.linux.do");
    return url.searchParams.get("order_no");
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseCode(text: string): number | null {
  const json = asRecord(safeJson(text));
  return json ? asNumber(json.code) : null;
}

export interface LdcClientLike {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  queryOrder(outTradeNo: string): Promise<QueryOrderResult>;
  refund(tradeNo: string, money: DecimalInput): Promise<RefundResult>;
}

export function createLdcClient(overrides: Partial<LdcClientOptions> = {}): LdcClient {
  const config = getConfig();
  return new LdcClient({
    pid: config.LDC_PID,
    key: config.LDC_KEY,
    baseUrl: config.LDC_API_BASE,
    ...overrides,
  });
}

let cachedClient: LdcClient | null = null;

export function getLdcClient(): LdcClient {
  if (!cachedClient) cachedClient = createLdcClient();
  return cachedClient;
}

/** 供类型展示用：LDC 金额（2 位小数）。 */
export function formatLdcAmount(value: DecimalInput): string {
  return dec(value).toFixed(2);
}

export type { Decimal };
