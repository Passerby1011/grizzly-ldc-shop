import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSignPayload,
  canonicalizeParams,
  epaySign,
  extractOrderNo,
  isTradeSuccess,
  LdcClient,
  signParams,
  verifyEpaySign,
} from "../ldc";

const KEY = "test_secret_key";

function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex").toLowerCase();
}

describe("签名原文拼接（SPEC 示例）", () => {
  /* SPEC 里给出的示例：
     payload = "money=10&name=Test&out_trade_no=M20250101&pid=001&type=epay"
     sign    = md5(payload + LDC_KEY).toLowerCase() */
  const params = {
    pid: "001",
    type: "epay",
    out_trade_no: "M20250101",
    name: "Test",
    money: 10,
  };

  it("按参数名 ASCII 升序拼 k1=v1&k2=v2", () => {
    expect(buildSignPayload(params)).toBe(
      "money=10&name=Test&out_trade_no=M20250101&pid=001&type=epay",
    );
  });

  it("签名 = md5(payload + key) 小写十六进制", () => {
    const expected = md5("money=10&name=Test&out_trade_no=M20250101&pid=001&type=epay" + KEY);
    expect(epaySign(params, KEY)).toBe(expected);
    expect(epaySign(params, KEY)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("参数顺序不影响签名（内部会排序）", () => {
    const shuffled = {
      type: "epay",
      money: 10,
      pid: "001",
      name: "Test",
      out_trade_no: "M20250101",
    };
    expect(epaySign(shuffled, KEY)).toBe(epaySign(params, KEY));
  });
});

describe("签名参数规范化", () => {
  it("排除 sign 与 sign_type", () => {
    const payload = buildSignPayload({ b: 2, sign: "abc", sign_type: "MD5", a: 1 });
    expect(payload).toBe("a=1&b=2");
  });

  it("剔除空值（空串 / null / undefined）", () => {
    const payload = buildSignPayload({ a: 1, empty: "", nil: null, missing: undefined });
    expect(payload).toBe("a=1");
  });

  it("排序对大小写敏感（大写字母在前）", () => {
    expect(buildSignPayload({ b: 1, A: 2, a: 3 })).toBe("A=2&a=3&b=1");
  });

  it("数字参数转字符串参与签名", () => {
    expect(canonicalizeParams({ money: 10.5 })).toEqual([["money", "10.5"]]);
  });

  it("signParams 补齐 sign 与 sign_type=MD5", () => {
    const signed = signParams({ pid: "001", type: "epay", money: 10 }, KEY);
    expect(signed.sign_type).toBe("MD5");
    expect(signed.sign).toBe(epaySign({ pid: "001", type: "epay", money: 10 }, KEY));
  });
});

describe("验签", () => {
  const notify = {
    pid: "001",
    trade_no: "T20250101",
    out_trade_no: "M20250101",
    type: "epay",
    name: "Test",
    money: "10.00",
    trade_status: "TRADE_SUCCESS",
  };

  it("正确签名通过", () => {
    const sign = epaySign(notify, KEY);
    expect(verifyEpaySign({ ...notify, sign }, KEY)).toBe(true);
  });

  it("被篡改的金额拒绝", () => {
    const sign = epaySign(notify, KEY);
    expect(verifyEpaySign({ ...notify, money: "1.00", sign }, KEY)).toBe(false);
  });

  it("被篡改的签名拒绝", () => {
    expect(verifyEpaySign({ ...notify, sign: "0".repeat(32) }, KEY)).toBe(false);
  });

  it("换密钥拒绝", () => {
    const sign = epaySign(notify, KEY);
    expect(verifyEpaySign({ ...notify, sign }, "other_key")).toBe(false);
  });

  it("缺签名拒绝", () => {
    expect(verifyEpaySign(notify, KEY)).toBe(false);
    expect(verifyEpaySign({ ...notify, sign: "" }, KEY)).toBe(false);
  });

  it("大写签名也认（比较前统一小写）", () => {
    const sign = epaySign(notify, KEY).toUpperCase();
    expect(verifyEpaySign({ ...notify, sign }, KEY)).toBe(true);
  });

  it("trade_status 判定", () => {
    expect(isTradeSuccess({ trade_status: "TRADE_SUCCESS" })).toBe(true);
    expect(isTradeSuccess({ trade_status: "trade_success" })).toBe(true);
    expect(isTradeSuccess({ trade_status: "TRADE_FAILED" })).toBe(false);
    expect(isTradeSuccess({})).toBe(false);
  });
});

describe("extractOrderNo", () => {
  it("从收银台 URL 取 order_no", () => {
    expect(extractOrderNo("https://credit.linux.do/paying?order_no=ABC123")).toBe("ABC123");
    expect(extractOrderNo("/paying?order_no=ABC123")).toBe("ABC123");
    expect(extractOrderNo("https://credit.linux.do/paying")).toBeNull();
  });
});

describe("LdcClient.createOrder", () => {
  it("302 跳转被识别为下单成功", async () => {
    const captured: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("", {
        status: 302,
        headers: { location: "https://credit.linux.do/paying?order_no=ORDER9" },
      });
    }) as unknown as typeof fetch;

    const client = new LdcClient({ pid: "001", key: KEY, baseUrl: "https://credit.linux.do/epay", fetchImpl: fakeFetch });
    const result = await client.createOrder({
      outTradeNo: "M20250101",
      name: "Test",
      money: "10.00",
      notifyUrl: "https://shop.example.com/api/pay/notify",
    });

    expect(result.orderNo).toBe("ORDER9");
    expect(result.payUrl).toContain("order_no=ORDER9");
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain("/pay/submit.php");

    const body = new URLSearchParams(captured[0].body);
    expect(body.get("pid")).toBe("001");
    expect(body.get("type")).toBe("epay");
    expect(body.get("money")).toBe("10.00");
    expect(body.get("sign_type")).toBe("MD5");
    expect(body.get("sign")).toBe(
      epaySign(
        {
          pid: "001",
          type: "epay",
          out_trade_no: "M20250101",
          name: "Test",
          money: "10.00",
          notify_url: "https://shop.example.com/api/pay/notify",
        },
        KEY,
      ),
    );
  });

  it("HTTP 401 直接抛出（实测签名错误码）", async () => {
    const fakeFetch = (async () =>
      new Response('{"code":-1,"msg":"sign error"}', { status: 401 })) as unknown as typeof fetch;
    const client = new LdcClient({ pid: "001", key: KEY, baseUrl: "https://credit.linux.do/epay", fetchImpl: fakeFetch });
    await expect(client.createOrder({ outTradeNo: "M1", name: "Test", money: "1.00" })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("name 超过 64 字符会被截断", async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("", { status: 302, headers: { location: "/paying?order_no=X" } });
    }) as unknown as typeof fetch;
    const client = new LdcClient({ pid: "001", key: KEY, baseUrl: "https://credit.linux.do/epay", fetchImpl: fakeFetch });
    await client.createOrder({ outTradeNo: "M1", name: "x".repeat(200), money: "1.00" });
    expect(new URLSearchParams(bodies[0]).get("name")).toHaveLength(64);
  });
});

describe("LdcClient.queryOrder", () => {
  it("status=1 视为已支付", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: 1, status: 1, trade_no: "T1" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = new LdcClient({ pid: "001", key: KEY, baseUrl: "https://credit.linux.do/epay", fetchImpl: fakeFetch });
    const result = await client.queryOrder("M1");
    expect(result).toMatchObject({ found: true, paid: true, status: 1, tradeNo: "T1" });
  });

  it("HTTP 404 视为订单不存在（不抛错）", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: -1, msg: "订单不存在或已完成" }), {
        status: 404,
      })) as unknown as typeof fetch;
    const client = new LdcClient({ pid: "001", key: KEY, baseUrl: "https://credit.linux.do/epay", fetchImpl: fakeFetch });
    const result = await client.queryOrder("M1");
    expect(result.found).toBe(false);
    expect(result.paid).toBe(false);
  });

  it("status=0 视为处理中", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ code: 1, status: 0 }), { status: 200 })) as unknown as typeof fetch;
    const client = new LdcClient({ pid: "001", key: KEY, baseUrl: "https://credit.linux.do/epay", fetchImpl: fakeFetch });
    const result = await client.queryOrder("M1");
    expect(result.found).toBe(true);
    expect(result.paid).toBe(false);
  });
});

describe("LdcClient.refund", () => {
  it("code=1 视为退款成功", async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ code: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new LdcClient({ pid: "001", key: KEY, baseUrl: "https://credit.linux.do/epay", fetchImpl: fakeFetch });
    const result = await client.refund("T1", "10.00");
    expect(result.ok).toBe(true);
    expect(new URLSearchParams(bodies[0]).get("money")).toBe("10.00");
    expect(new URLSearchParams(bodies[0]).get("trade_no")).toBe("T1");
  });
});
