/**
 * Grizzly SMS Client API 客户端。
 *
 * 上游事实（2026-10-10 实测，勿改）：
 * - 基址 `https://api.grizzlysms.com/stubs/handler_api.php`，**全部 GET**，每个请求带 `api_key`。
 * - 响应是「纯文本」而非 JSON（除 getCountries / getServicesList / getNumbersStatus / getStatusV2 等）。
 * - `getPrices` / `getPricesV2` / `getPricesV3` 在该 host 实测返回 `BAD_ACTION`，因此估价必须走
 *   PriceProvider：先试 API → 静默降级到本地 PriceCache → 最后兜底常量。
 * - `getNumber` 必须带 `maxPrice` 上限，杜绝超支。
 */
import { dec, type Decimal, type DecimalInput } from "./money";
import { getPrisma } from "./db";
import { getConfig } from "./config";

export const GRIZZLY_ACTIONS = {
  getBalance: "getBalance",
  getCountries: "getCountries",
  getServicesList: "getServicesList",
  getNumbersStatus: "getNumbersStatus",
  getNumber: "getNumber",
  setStatus: "setStatus",
  getStatus: "getStatus",
  getStatusV2: "getStatusV2",
  getActiveActivations: "getActiveActivations",
  getPrices: "getPrices",
  getPricesV2: "getPricesV2",
  getPricesV3: "getPricesV3",
} as const;

/** setStatus 的语义：1=就绪 3=请求重发 6=完成（正式扣费） 8=取消（退款）。 */
export const GRIZZLY_STATUS = {
  READY: 1,
  RETRY_GET: 3,
  ACTIVATION: 6,
  CANCEL: 8,
} as const;

export type GrizzlySetStatus = (typeof GRIZZLY_STATUS)[keyof typeof GRIZZLY_STATUS];

export type GrizzlyErrorCode =
  | "EARLY_CANCEL_DENIED"
  | "BAD_KEY"
  | "BAD_ACTION"
  | "BAD_STATUS"
  | "NO_BALANCE"
  | "NO_NUMBERS"
  | "NO_ACTIVATION"
  | "SERVICE_UNAVAILABLE_REGION"
  | "SERVICE_PROHIBITED"
  | "WRONG_MAX_PRICE"
  | "EMPTY_RESPONSE"
  | "UNKNOWN";

const ERROR_TOKENS: Array<[string, GrizzlyErrorCode]> = [
  ["EARLY_CANCEL_DENIED", "EARLY_CANCEL_DENIED"],
  ["BAD_KEY", "BAD_KEY"],
  ["BAD_ACTION", "BAD_ACTION"],
  ["BAD_STATUS", "BAD_STATUS"],
  ["NO_BALANCE", "NO_BALANCE"],
  ["NO_NUMBERS", "NO_NUMBERS"],
  ["NO_ACTIVATION", "NO_ACTIVATION"],
  ["SERVICE_UNAVAILABLE_REGION", "SERVICE_UNAVAILABLE_REGION"],
  ["WRONG_MAX_PRICE", "WRONG_MAX_PRICE"],
];

export class GrizzlyApiError extends Error {
  readonly code: GrizzlyErrorCode;
  readonly raw: string;

  constructor(code: GrizzlyErrorCode, raw: string) {
    super(`Grizzly 返回错误 ${code}: ${raw}`);
    this.name = "GrizzlyApiError";
    this.code = code;
    this.raw = raw;
  }
}

export class GrizzlyTransportError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status = 0, body = "") {
    super(message);
    this.name = "GrizzlyTransportError";
    this.status = status;
    this.body = body;
  }
}

/** 把上游错误文本映射成结构化错误码。 */
export function mapGrizzlyError(raw: string): GrizzlyErrorCode | null {
  const text = raw.trim();
  if (text === "") return "EMPTY_RESPONSE";
  if (text.startsWith("ACCESS_") || text.startsWith("STATUS_")) return null;
  if (/prohibited/i.test(text)) return "SERVICE_PROHIBITED";
  for (const [token, code] of ERROR_TOKENS) {
    if (text === token || text.startsWith(`${token}:`)) return code;
  }
  return null;
}

/** 抛出上游业务错误（若有）。 */
export function assertNoGrizzlyError(raw: string): string {
  const code = mapGrizzlyError(raw);
  if (code) throw new GrizzlyApiError(code, raw.trim());
  return raw.trim();
}

/** `ACCESS_BALANCE:4.1326` → 4.1326（美元）。 */
export function parseBalance(text: string): Decimal {
  const trimmed = text.trim();
  const match = /^ACCESS_BALANCE:(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!match) {
    assertNoGrizzlyError(trimmed);
    throw new GrizzlyApiError("UNKNOWN", trimmed);
  }
  return dec(match[1]);
}

/** `ACCESS_NUMBER:<激活ID>:<号码>` → { id, phone }。 */
export function parseAccessNumber(text: string): { id: string; phone: string } {
  const trimmed = text.trim();
  const match = /^ACCESS_NUMBER:([^:]+):(.+)$/.exec(trimmed);
  if (!match) {
    assertNoGrizzlyError(trimmed);
    throw new GrizzlyApiError("UNKNOWN", trimmed);
  }
  return { id: match[1].trim(), phone: match[2].trim() };
}

export type ParsedStatus =
  | { state: "WAIT_CODE" }
  | { state: "WAIT_RETRY"; code: string }
  | { state: "WAIT_RESEND" }
  | { state: "CANCEL" }
  | { state: "OK"; code: string }
  | { state: "UNKNOWN"; raw: string };

/** `STATUS_*` → 结构化状态。 */
export function parseStatus(text: string): ParsedStatus {
  const trimmed = text.trim();
  if (trimmed === "STATUS_WAIT_CODE") return { state: "WAIT_CODE" };
  if (trimmed === "STATUS_WAIT_RESEND") return { state: "WAIT_RESEND" };
  if (trimmed === "STATUS_CANCEL") return { state: "CANCEL" };
  const retry = /^STATUS_WAIT_RETRY:(.*)$/.exec(trimmed);
  if (retry) return { state: "WAIT_RETRY", code: retry[1].trim() };
  const ok = /^STATUS_OK:(.*)$/.exec(trimmed);
  if (ok) return { state: "OK", code: ok[1].trim() };
  const code = mapGrizzlyError(trimmed);
  if (code) throw new GrizzlyApiError(code, trimmed);
  return { state: "UNKNOWN", raw: trimmed };
}

/** `ACCESS_READY` / `ACCESS_RETRY_GET` / `ACCESS_ACTIVATION` / `ACCESS_CANCEL`。 */
export function parseSetStatus(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("ACCESS_")) {
    assertNoGrizzlyError(trimmed);
    throw new GrizzlyApiError("UNKNOWN", trimmed);
  }
  return trimmed.slice("ACCESS_".length);
}

export interface GrizzlyCountry {
  id: number;
  eng: string;
  rus?: string;
  chn?: string;
  visible: number;
  retry: number;
}

export interface GrizzlyService {
  code: string;
  name: string;
}

export interface GrizzlyAvailabilityItem {
  /** 原始键，例如 `telegram_0`。 */
  key: string;
  service: string;
  operator: string;
  count: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asInt(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `{"1":{"id":1,"eng":"Ukraine",...}}` → 数组。 */
export function parseCountries(json: unknown): GrizzlyCountry[] {
  const raw = asRecord(json);
  const entries: unknown[] = Array.isArray(json)
    ? json
    : raw
      ? Object.values(raw)
      : [];
  const out: GrizzlyCountry[] = [];
  for (const entry of entries) {
    const item = asRecord(entry);
    if (!item) continue;
    const id = asInt(item.id, Number.NaN);
    const eng = asString(item.eng);
    if (!Number.isFinite(id) || !eng) continue;
    out.push({
      id,
      eng,
      rus: asString(item.rus),
      chn: asString(item.chn),
      visible: asInt(item.visible, 1),
      retry: asInt(item.retry, 0),
    });
  }
  return out.sort((a, b) => a.eng.localeCompare(b.eng));
}

/** `{"services":[{"code":"sk","name":"Skroutz"}]}` → 数组。 */
export function parseServices(json: unknown): GrizzlyService[] {
  const root = asRecord(json);
  const list = root ? root.services : undefined;
  const entries: unknown[] = Array.isArray(list) ? list : [];
  const out: GrizzlyService[] = [];
  for (const entry of entries) {
    const item = asRecord(entry);
    if (!item) continue;
    const code = asString(item.code);
    if (!code) continue;
    out.push({ code, name: asString(item.name) ?? code });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `{"telegram_0":20,"aa_1":100}` → 结构化数组。 */
export function parseNumbersStatus(json: unknown): GrizzlyAvailabilityItem[] {
  const raw = asRecord(json);
  if (!raw) return [];
  const out: GrizzlyAvailabilityItem[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const count = asInt(value, 0);
    const separator = key.indexOf("_");
    const service = separator === -1 ? key : key.slice(0, separator);
    const operator = separator === -1 ? "any" : key.slice(separator + 1);
    out.push({ key, service, operator, count });
  }
  return out.sort((a, b) => b.count - a.count || a.service.localeCompare(b.service));
}

/** getActiveActivations 无激活时返回 `null`。 */
export function parseActiveActivations(json: unknown): unknown[] {
  if (json === null || json === undefined) return [];
  return Array.isArray(json) ? json : [];
}

export interface GrizzlyClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GrizzlyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GrizzlyClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.retries = Math.max(1, options.retries ?? 3);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 统一 GET：超时 + 网络/5xx 重试；业务错误原样返回文本，由解析层处理。 */
  async requestText(params: Record<string, string | number>): Promise<string> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("api_key", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    let lastError: unknown = new GrizzlyTransportError("未发起请求");
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url.toString(), {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
          headers: { accept: "text/plain, application/json" },
        });
        const text = (await response.text()).trim();
        if (!response.ok) {
          if (response.status >= 500 && attempt < this.retries) {
            lastError = new GrizzlyTransportError(`HTTP ${response.status}`, response.status, text);
          } else {
            throw new GrizzlyTransportError(`HTTP ${response.status}`, response.status, text);
          }
        } else {
          return text;
        }
      } catch (error) {
        if (error instanceof GrizzlyTransportError && error.status > 0 && error.status < 500) {
          throw error;
        }
        lastError = error;
        if (attempt >= this.retries) break;
      } finally {
        clearTimeout(timer);
      }
      await sleep(150 * attempt);
    }
    if (lastError instanceof Error) throw lastError;
    throw new GrizzlyTransportError(String(lastError));
  }

  /** GET + 业务错误检测。 */
  async call(params: Record<string, string | number>): Promise<string> {
    return assertNoGrizzlyError(await this.requestText(params));
  }

  async getBalance(): Promise<Decimal> {
    return parseBalance(await this.requestText({ action: GRIZZLY_ACTIONS.getBalance }));
  }

  async getCountries(): Promise<GrizzlyCountry[]> {
    return parseCountries(await this.json({ action: GRIZZLY_ACTIONS.getCountries }));
  }

  async getServicesList(): Promise<GrizzlyService[]> {
    return parseServices(await this.json({ action: GRIZZLY_ACTIONS.getServicesList }));
  }

  async getNumbersStatus(country: string | number): Promise<GrizzlyAvailabilityItem[]> {
    return parseNumbersStatus(
      await this.json({ action: GRIZZLY_ACTIONS.getNumbersStatus, country: String(country) }),
    );
  }

  async getNumber(input: {
    service: string;
    country: string | number;
    maxPrice: DecimalInput;
  }): Promise<{ id: string; phone: string }> {
    return parseAccessNumber(
      await this.call({
        action: GRIZZLY_ACTIONS.getNumber,
        service: input.service,
        country: String(input.country),
        maxPrice: dec(input.maxPrice).toFixed(2),
      }),
    );
  }

  async setStatus(id: string, status: GrizzlySetStatus): Promise<string> {
    return parseSetStatus(await this.call({ action: GRIZZLY_ACTIONS.setStatus, id, status }));
  }

  async getStatus(id: string): Promise<ParsedStatus> {
    return parseStatus(await this.call({ action: GRIZZLY_ACTIONS.getStatus, id }));
  }

  async getStatusV2(id: string): Promise<unknown> {
    return this.json({ action: GRIZZLY_ACTIONS.getStatusV2, id });
  }

  async getActiveActivations(): Promise<unknown[]> {
    return parseActiveActivations(await this.json({ action: GRIZZLY_ACTIONS.getActiveActivations }));
  }

  /** 价格接口实测 BAD_ACTION；解析保持宽容，失败/不识别一律返回 null。 */
  async getPriceFromApi(
    service: string,
    country: string,
    actions: readonly string[] = [
      GRIZZLY_ACTIONS.getPrices,
      GRIZZLY_ACTIONS.getPricesV2,
      GRIZZLY_ACTIONS.getPricesV3,
    ],
  ): Promise<{ priceUsd: Decimal; action: string } | null> {
    for (const action of actions) {
      try {
        const json = await this.json({ action, service, country });
        const price = pickPrice(json, country, service);
        if (price !== null) return { priceUsd: dec(price), action };
      } catch {
        // 静默降级：BAD_ACTION / 超时 / 任何异常都不影响估价
      }
    }
    return null;
  }

  private async json(params: Record<string, string | number>): Promise<unknown> {
    const text = await this.requestText(params);
    const code = mapGrizzlyError(text);
    if (code) throw new GrizzlyApiError(code, text);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GrizzlyApiError("UNKNOWN", text.slice(0, 200));
    }
  }
}

/** 宽容地从（未经核实形状的）价格响应里挑出一个价格。 */
export function pickPrice(json: unknown, country: string, service: string): number | null {
  const candidates: unknown[] = [];
  const root = asRecord(json);
  if (!root) return null;
  for (const first of [country, service]) {
    for (const second of [country, service]) {
      const node = asRecord(root[first]);
      if (!node) continue;
      const leaf = node[second];
      candidates.push(leaf);
      const leafRecord = asRecord(leaf);
      if (leafRecord) candidates.push(leafRecord.cost, leafRecord.price, leafRecord.rate);
    }
  }
  candidates.push(root.cost, root.price);
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** 兜底价（美元）：两个价格来源都落空时使用，宁可高估不可超支。 */
export const FALLBACK_PRICE_USD = "0.50";

export interface PriceCacheStore {
  read(service: string, country: string): Promise<{ costUsd: Decimal; source: string } | null>;
  write(service: string, country: string, costUsd: Decimal, source: string): Promise<void>;
}

export function createPrismaPriceCacheStore(): PriceCacheStore {
  return {
    async read(service, country) {
      const row = await getPrisma().priceCache.findUnique({
        where: { service_country: { service, country } },
      });
      if (!row) return null;
      return { costUsd: dec(row.costUsd.toString()), source: row.source };
    },
    async write(service, country, costUsd, source) {
      const value = dec(costUsd).toFixed(4);
      await getPrisma().priceCache.upsert({
        where: { service_country: { service, country } },
        create: { service, country, costUsd: value, source },
        update: { costUsd: value, source },
      });
    },
  };
}

export interface PriceQuote {
  service: string;
  country: string;
  priceUsd: Decimal;
  source: "api" | "cache" | "default";
}

/**
 * 估价器：上游价格接口 → 本地 PriceCache → 兜底常量。
 * 真实成交后调用 `observe()` 回填 `observed` 成本。
 */
export class PriceProvider {
  private readonly client: GrizzlyClient;
  private readonly cache: PriceCacheStore;
  private readonly fallbackUsd: Decimal;

  constructor(client: GrizzlyClient, cache: PriceCacheStore, fallbackUsd: DecimalInput = FALLBACK_PRICE_USD) {
    this.client = client;
    this.cache = cache;
    this.fallbackUsd = dec(fallbackUsd);
  }

  async quote(service: string, country: string): Promise<PriceQuote> {
    const fromApi = await this.client.getPriceFromApi(service, country);
    if (fromApi) {
      return { service, country, priceUsd: fromApi.priceUsd, source: "api" };
    }
    const cached = await this.cache.read(service, country);
    if (cached) {
      return { service, country, priceUsd: cached.costUsd, source: "cache" };
    }
    return { service, country, priceUsd: this.fallbackUsd, source: "default" };
  }

  /** 真实成交成本回填（source=observed）。 */
  async observe(service: string, country: string, costUsd: DecimalInput): Promise<void> {
    await this.cache.write(service, country, dec(costUsd), "observed");
  }

  /** 管理端手填（source=manual）。 */
  async setManual(service: string, country: string, costUsd: DecimalInput): Promise<void> {
    await this.cache.write(service, country, dec(costUsd), "manual");
  }
}

export interface GrizzlyClientLike {
  getBalance(): Promise<Decimal>;
}

export function createGrizzlyClient(overrides: Partial<GrizzlyClientOptions> = {}): GrizzlyClient {
  const config = getConfig();
  return new GrizzlyClient({
    apiKey: config.GRIZZLY_API_KEY,
    baseUrl: config.GRIZZLY_API_BASE,
    ...overrides,
  });
}

let cachedClient: GrizzlyClient | null = null;
let cachedProvider: PriceProvider | null = null;

export function getGrizzlyClient(): GrizzlyClient {
  if (!cachedClient) cachedClient = createGrizzlyClient();
  return cachedClient;
}

export function getPriceProvider(): PriceProvider {
  if (!cachedProvider) cachedProvider = new PriceProvider(getGrizzlyClient(), createPrismaPriceCacheStore());
  return cachedProvider;
}

/** 极简 TTL 缓存（进程内）。同 key 并发只打一次上游。 */
export class TtlCache<T> {
  private value: T | undefined;
  private expiresAt = 0;
  private inflight: Promise<T> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly loader: () => Promise<T>,
  ) {}

  async get(): Promise<T> {
    const now = Date.now();
    if (this.value !== undefined && now < this.expiresAt) return this.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.loader()
      .then((value) => {
        this.value = value;
        this.expiresAt = Date.now() + this.ttlMs;
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

const CATALOG_TTL_MS = 10 * 60 * 1000;
const AVAILABILITY_TTL_MS = 60 * 1000;

const countriesCache = new TtlCache(CATALOG_TTL_MS, () => getGrizzlyClient().getCountries());
const servicesCache = new TtlCache(CATALOG_TTL_MS, () => getGrizzlyClient().getServicesList());
const availabilityCache = new Map<string, TtlCache<GrizzlyAvailabilityItem[]>>();

export function getCountriesCached(): Promise<GrizzlyCountry[]> {
  return countriesCache.get();
}

export function getServicesCached(): Promise<GrizzlyService[]> {
  return servicesCache.get();
}

export function getNumbersStatusCached(country: string): Promise<GrizzlyAvailabilityItem[]> {
  let cache = availabilityCache.get(country);
  if (!cache) {
    cache = new TtlCache(AVAILABILITY_TTL_MS, () => getGrizzlyClient().getNumbersStatus(country));
    availabilityCache.set(country, cache);
  }
  return cache.get();
}
