import { describe, expect, it } from "vitest";
import {
  assertNoGrizzlyError,
  FALLBACK_PRICE_USD,
  GrizzlyApiError,
  GrizzlyClient,
  mapGrizzlyError,
  parseAccessNumber,
  parseActiveActivations,
  parseBalance,
  parseCountries,
  parseNumbersStatus,
  parseServices,
  parseSetStatus,
  parseStatus,
  PriceProvider,
  type PriceCacheStore,
} from "../grizzly";
import { dec } from "../money";
import type { Decimal } from "../money";

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string | URL | Request) => handler(new URL(String(input)))) as unknown as typeof fetch;
}

describe("错误映射", () => {
  it("识别 SPEC 列出的错误码", () => {
    expect(mapGrizzlyError("BAD_KEY")).toBe("BAD_KEY");
    expect(mapGrizzlyError("BAD_ACTION")).toBe("BAD_ACTION");
    expect(mapGrizzlyError("NO_BALANCE")).toBe("NO_BALANCE");
    expect(mapGrizzlyError("NO_NUMBERS")).toBe("NO_NUMBERS");
    expect(mapGrizzlyError("SERVICE_UNAVAILABLE_REGION")).toBe("SERVICE_UNAVAILABLE_REGION");
  });

  it("识别 EARLY_CANCEL_DENIED（2026-10-10 实测：取消过早返回的纯文本）", () => {
    expect(mapGrizzlyError("EARLY_CANCEL_DENIED")).toBe("EARLY_CANCEL_DENIED");
    expect(mapGrizzlyError("EARLY_CANCEL_DENIED:try later")).toBe("EARLY_CANCEL_DENIED");
  });

  it("识别「禁止销售」自由文本", () => {
    expect(mapGrizzlyError("The service is prohibited for sale by administration")).toBe(
      "SERVICE_PROHIBITED",
    );
  });

  it("正常响应不算错误", () => {
    expect(mapGrizzlyError("ACCESS_NUMBER:1:7999")).toBeNull();
    expect(mapGrizzlyError("STATUS_OK:1234")).toBeNull();
  });

  it("空响应标记为 EMPTY_RESPONSE", () => {
    expect(mapGrizzlyError("")).toBe("EMPTY_RESPONSE");
    expect(mapGrizzlyError("   ")).toBe("EMPTY_RESPONSE");
  });

  it("assertNoGrizzlyError 对错误文本抛 GrizzlyApiError", () => {
    expect(() => assertNoGrizzlyError("NO_BALANCE")).toThrow(GrizzlyApiError);
    expect(() => assertNoGrizzlyError("BAD_ACTION")).toThrow(GrizzlyApiError);
    expect(assertNoGrizzlyError(" ACCESS_READY ")).toBe("ACCESS_READY");
  });
});

describe("解析：getBalance", () => {
  it("ACCESS_BALANCE:4.1326 → 4.1326", () => {
    expect(parseBalance("ACCESS_BALANCE:4.1326").toFixed(4)).toBe("4.1326");
  });

  it("BAD_KEY 抛结构化错误", () => {
    try {
      parseBalance("BAD_KEY");
      throw new Error("不该走到这里");
    } catch (error) {
      expect(error).toBeInstanceOf(GrizzlyApiError);
      expect((error as GrizzlyApiError).code).toBe("BAD_KEY");
    }
  });
});

describe("解析：getNumber", () => {
  it("ACCESS_NUMBER:<id>:<phone> → 结构化", () => {
    expect(parseAccessNumber("ACCESS_NUMBER:12345678:79991234567")).toEqual({
      id: "12345678",
      phone: "79991234567",
    });
  });

  it("号码里带冒号也能解析完整", () => {
    expect(parseAccessNumber("ACCESS_NUMBER:1:+7:999").phone).toBe("+7:999");
  });

  it("NO_NUMBERS → 结构化错误码", () => {
    try {
      parseAccessNumber("NO_NUMBERS");
      throw new Error("不该走到这里");
    } catch (error) {
      expect((error as GrizzlyApiError).code).toBe("NO_NUMBERS");
    }
  });
});

describe("解析：getStatus", () => {
  it("STATUS_WAIT_CODE", () => {
    expect(parseStatus("STATUS_WAIT_CODE")).toEqual({ state: "WAIT_CODE" });
  });

  it("STATUS_WAIT_RETRY:<code>", () => {
    expect(parseStatus("STATUS_WAIT_RETRY:1234")).toEqual({ state: "WAIT_RETRY", code: "1234" });
  });

  it("STATUS_WAIT_RESEND", () => {
    expect(parseStatus("STATUS_WAIT_RESEND")).toEqual({ state: "WAIT_RESEND" });
  });

  it("STATUS_CANCEL", () => {
    expect(parseStatus("STATUS_CANCEL")).toEqual({ state: "CANCEL" });
  });

  it("STATUS_OK:<code> → 验证码", () => {
    expect(parseStatus("STATUS_OK:54321")).toEqual({ state: "OK", code: "54321" });
  });

  it("未知状态不抛错，返回 UNKNOWN", () => {
    expect(parseStatus("SOMETHING_ELSE")).toEqual({ state: "UNKNOWN", raw: "SOMETHING_ELSE" });
  });
});

describe("解析：setStatus", () => {
  it("ACCESS_READY / ACCESS_ACTIVATION / ACCESS_CANCEL", () => {
    expect(parseSetStatus("ACCESS_READY")).toBe("READY");
    expect(parseSetStatus("ACCESS_ACTIVATION")).toBe("ACTIVATION");
    expect(parseSetStatus("ACCESS_CANCEL")).toBe("CANCEL");
    expect(parseSetStatus("ACCESS_RETRY_GET")).toBe("RETRY_GET");
  });

  it("EARLY_CANCEL_DENIED 抛 GrizzlyApiError 且 code 正确（不再是 UNKNOWN）", () => {
    try {
      parseSetStatus("EARLY_CANCEL_DENIED");
      throw new Error("不该走到这里");
    } catch (error) {
      expect(error).toBeInstanceOf(GrizzlyApiError);
      expect((error as GrizzlyApiError).code).toBe("EARLY_CANCEL_DENIED");
      expect((error as GrizzlyApiError).raw).toBe("EARLY_CANCEL_DENIED");
    }
  });
});

describe("解析：JSON 端点", () => {
  it("getCountries：对象键 → 数组", () => {
    const countries = parseCountries({
      "1": { id: 1, eng: "Ukraine", visible: 1, retry: 1 },
      "10": { id: 10, eng: "Australia", visible: 1, retry: 0 },
    });
    expect(countries).toHaveLength(2);
    expect(countries[0].eng).toBe("Australia");
    expect(countries[1].id).toBe(1);
  });

  it("getServicesList：services 数组", () => {
    const services = parseServices({
      services: [
        { code: "sk", name: "Skroutz" },
        { code: "tg", name: "Telegram" },
      ],
    });
    expect(services.map((item) => item.code)).toEqual(["sk", "tg"]);
  });

  it("getNumbersStatus：键拆成 service_operator", () => {
    const items = parseNumbersStatus({ telegram_0: 20, aa_1: 100 });
    expect(items[0]).toMatchObject({ service: "aa", operator: "1", count: 100 });
    expect(items[1]).toMatchObject({ service: "telegram", operator: "0", count: 20 });
  });

  it("getActiveActivations：null → 空数组", () => {
    expect(parseActiveActivations(null)).toEqual([]);
    expect(parseActiveActivations([{ id: 1 }])).toHaveLength(1);
  });
});

describe("GrizzlyClient 请求构造", () => {
  it("getNumber 必带 maxPrice 且保留两位小数", async () => {
    const seen: URL[] = [];
    const client = new GrizzlyClient({
      apiKey: "KEY",
      baseUrl: "https://api.grizzlysms.com/stubs/handler_api.php",
      fetchImpl: fakeFetch((url) => {
        seen.push(url);
        return new Response("ACCESS_NUMBER:9:79990001122", { status: 200 });
      }),
    });
    const result = await client.getNumber({ service: "tg", country: "0", maxPrice: "0.5" });
    expect(result).toEqual({ id: "9", phone: "79990001122" });
    expect(seen).toHaveLength(1);
    expect(seen[0].searchParams.get("action")).toBe("getNumber");
    expect(seen[0].searchParams.get("api_key")).toBe("KEY");
    expect(seen[0].searchParams.get("maxPrice")).toBe("0.50");
  });

  it("getStatus 把 ACCESS 错误抛成结构化错误", async () => {
    const client = new GrizzlyClient({
      apiKey: "KEY",
      baseUrl: "https://api.grizzlysms.com/stubs/handler_api.php",
      fetchImpl: fakeFetch(() => new Response("NO_ACTIVATION", { status: 200 })),
    });
    await expect(client.getStatus("1")).rejects.toMatchObject({ code: "NO_ACTIVATION" });
  });
});

describe("PriceProvider（上游 BAD_ACTION 降级）", () => {
  interface MemoryCache {
    store: PriceCacheStore;
    written: Array<{ costUsd: string; source: string }>;
  }

  function memoryCache(seed?: { costUsd: string; source: string }): MemoryCache {
    const written: Array<{ costUsd: string; source: string }> = [];
    return {
      written,
      store: {
        async read() {
          return seed ? { costUsd: dec(seed.costUsd), source: seed.source } : null;
        },
        async write(_service: string, _country: string, costUsd: Decimal, source: string) {
          written.push({ costUsd: costUsd.toFixed(4), source });
        },
      },
    };
  }

  it("上游返回 BAD_ACTION → 静默降级到本地缓存", async () => {
    const client = new GrizzlyClient({
      apiKey: "KEY",
      baseUrl: "https://api.grizzlysms.com/stubs/handler_api.php",
      fetchImpl: fakeFetch(() => new Response("BAD_ACTION", { status: 200 })),
    });
    const cache = memoryCache({ costUsd: "0.42", source: "observed" });
    const provider = new PriceProvider(client, cache.store);
    const quote = await provider.quote("tg", "0");
    expect(quote.source).toBe("cache");
    expect(quote.priceUsd.toFixed(2)).toBe("0.42");
  });

  it("上游 + 缓存都落空 → 用兜底常量（宁可高估）", async () => {
    const client = new GrizzlyClient({
      apiKey: "KEY",
      baseUrl: "https://api.grizzlysms.com/stubs/handler_api.php",
      fetchImpl: fakeFetch(() => new Response("BAD_ACTION", { status: 200 })),
    });
    const provider = new PriceProvider(client, memoryCache().store);
    const quote = await provider.quote("tg", "0");
    expect(quote.source).toBe("default");
    expect(quote.priceUsd.toFixed(2)).toBe(Number(FALLBACK_PRICE_USD).toFixed(2));
  });

  it("observe 回填真实成交成本", async () => {
    const client = new GrizzlyClient({
      apiKey: "KEY",
      baseUrl: "https://api.grizzlysms.com/stubs/handler_api.php",
      fetchImpl: fakeFetch(() => new Response("BAD_ACTION", { status: 200 })),
    });
    const cache = memoryCache();
    const provider = new PriceProvider(client, cache.store);
    await provider.observe("tg", "0", "0.37");
    expect(cache.written).toEqual([{ costUsd: "0.3700", source: "observed" }]);
  });
});
