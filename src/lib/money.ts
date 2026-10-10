/**
 * 金额工具：全部基于 Prisma.Decimal（decimal.js）的安全运算，纯函数。
 *
 * - 对买方报价（USD → LDC）一律「向上取整到 2 位小数」，绝不少收；
 * - 内部记账使用四舍五入到 2 位小数；
 * - 所有函数不读环境变量、不触网，可在测试中直接调用。
 */
import { Prisma } from "@prisma/client";

export type Decimal = Prisma.Decimal;
export type DecimalInput = Prisma.Decimal | string | number;

const DecimalCtor = Prisma.Decimal;

export const ZERO: Decimal = new DecimalCtor(0);
export const ONE: Decimal = new DecimalCtor(1);
export const CENT: Decimal = new DecimalCtor("0.01");

/** 安全地把任意输入转成 Decimal；number 走 String() 以避免二进制浮点误差放大。 */
export function dec(value: DecimalInput): Decimal {
  if (value instanceof DecimalCtor) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`金额非法: ${value}`);
    return new DecimalCtor(value.toString());
  }
  const trimmed = value.trim();
  if (trimmed === "") throw new RangeError("金额不能为空");
  let parsed: Decimal;
  try {
    parsed = new DecimalCtor(trimmed);
  } catch {
    throw new RangeError(`金额非法: ${value}`);
  }
  if (!parsed.isFinite()) throw new RangeError(`金额非法: ${value}`);
  return parsed;
}

/** 四舍五入到 2 位小数。 */
export function round2(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(2, DecimalCtor.ROUND_HALF_UP);
}

/** 向上取整到 2 位小数（0 < x <= 0.01 的结果是 0.01）。 */
export function roundUp2(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(2, DecimalCtor.ROUND_CEIL);
}

/** 向下取整到 2 位小数。 */
export function roundDown2(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(2, DecimalCtor.ROUND_FLOOR);
}

/** 有效汇率：RATE_LDC_PER_USD × (1 + MARKUP_PCT / 100)。 */
export function effectiveLdcRate(
  rateLdcPerUsd: DecimalInput,
  markupPct: DecimalInput = 0,
): Decimal {
  const rate = dec(rateLdcPerUsd);
  if (rate.lte(0)) throw new RangeError("RATE_LDC_PER_USD 必须大于 0");
  const markup = dec(markupPct);
  if (markup.lt(0)) throw new RangeError("MARKUP_PCT 不能为负");
  return rate.times(ONE.plus(markup.div(100)));
}

/** 美元面值 → 应向买家收取的 LDC 金额（向上取整到 2 位）。 */
export function usdToLdc(
  faceUsd: DecimalInput,
  rateLdcPerUsd: DecimalInput,
  markupPct: DecimalInput = 0,
): Decimal {
  const usd = dec(faceUsd);
  if (usd.isNegative()) throw new RangeError("美元金额不能为负");
  return roundUp2(usd.times(effectiveLdcRate(rateLdcPerUsd, markupPct)));
}

/** LDC 金额 → 等值美元（四舍五入到 2 位）。 */
export function ldcToUsd(
  amountLdc: DecimalInput,
  rateLdcPerUsd: DecimalInput,
  markupPct: DecimalInput = 0,
): Decimal {
  const amount = dec(amountLdc);
  if (amount.isNegative()) throw new RangeError("LDC 金额不能为负");
  return round2(amount.div(effectiveLdcRate(rateLdcPerUsd, markupPct)));
}

export function sumDecimals(values: readonly DecimalInput[]): Decimal {
  return values.reduce<Decimal>((acc, value) => acc.plus(dec(value)), ZERO);
}

export function isZero(value: DecimalInput): boolean {
  return dec(value).isZero();
}

export function isPositive(value: DecimalInput): boolean {
  return dec(value).gt(0);
}

export function gte(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).gte(dec(b));
}

export function lt(a: DecimalInput, b: DecimalInput): boolean {
  return dec(a).lt(dec(b));
}

export function minDecimal(a: DecimalInput, b: DecimalInput): Decimal {
  return dec(a).lt(dec(b)) ? dec(a) : dec(b);
}

/** 存库统一格式：4 位小数定长字符串（numeric(12,4)）。 */
export function toStorageString(value: DecimalInput): string {
  return dec(value).toFixed(4);
}

/** 展示格式：2 位小数。 */
export function formatUsd(value: DecimalInput): string {
  return dec(value).toFixed(2);
}

export function formatLdc(value: DecimalInput): string {
  return dec(value).toFixed(2);
}

/** 解析外部输入（表单 / JSON）里的金额，非法返回 null。 */
export function parseAmountInput(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  try {
    const value = dec(raw as DecimalInput);
    if (value.isNegative()) return null;
    return value;
  } catch {
    return null;
  }
}

/** Decimal → number（仅用于展示/日志，禁止用于记账）。 */
export function toNumber(value: DecimalInput): number {
  return dec(value).toNumber();
}
