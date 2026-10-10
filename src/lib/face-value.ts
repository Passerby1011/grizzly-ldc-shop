/**
 * 充值面值规则。
 *
 * 单独成一个模块，因为「能充多少」有两个调用方（下单接口 + 服务层），
 * 规则必须只有一份，否则很容易出现「接口放行、服务拒绝」这种不一致。
 *
 * 精度注意：一律走 Prisma.Decimal，不用 JS 浮点。
 * 0.1 在二进制浮点里不精确，`1.1 % 0.1 !== 0` 这类判断会误杀合法金额。
 */
import { dec, type Decimal, type DecimalInput } from "./money";
import { MAX_FACE_USD, MIN_FACE_USD } from "./pool";

/** 自定义充值的最小单位（美元）。用户可任意填写，但必须是这个值的整数倍。 */
export const CUSTOM_FACE_STEP_USD = "0.01";

/** 自定义充值的最小金额：一个步长。 */
export const MIN_CUSTOM_FACE_USD = CUSTOM_FACE_STEP_USD;

export interface FaceAmountCheck {
  ok: boolean;
  /** 解析出的金额；即使 ok=false 也会给出可用的 Decimal（默认 0），便于上层格式化。 */
  value: Decimal;
  /** ok=false 时的中文原因，可直接展示给买家。 */
  reason?: string;
}

/**
 * 校验一笔充值金额。
 *
 * 规则：
 *   1. 能解析成合法数字
 *   2. > 0
 *   3. >= MIN_FACE_USD（0.01，池子的硬下限）
 *   4. <= MAX_FACE_USD（1000）
 *   5. 必须是 CUSTOM_FACE_STEP_USD（0.01）的整数倍
 *
 * 注意第 3 与第 5 条叠加后，买家实际能填的最小值是 0.1；
 * MIN_FACE_USD 保留 0.01 是给后台发卡用的（后台可发更细的面值）。
 */
export function checkFaceAmount(input: DecimalInput): FaceAmountCheck {
  let value: Decimal;
  try {
    value = dec(input);
  } catch {
    return { ok: false, value: dec(0), reason: "金额格式不正确" };
  }

  if (!value.isFinite()) return { ok: false, value: dec(0), reason: "金额格式不正确" };
  if (value.lte(0)) return { ok: false, value, reason: "金额必须大于 0" };
  if (value.lt(MIN_FACE_USD)) {
    return { ok: false, value, reason: `金额不能小于 ${CUSTOM_FACE_STEP_USD} USD` };
  }
  if (value.gt(MAX_FACE_USD)) {
    return { ok: false, value, reason: `单次最多 ${MAX_FACE_USD} USD` };
  }

  /* 步长校验：用 Decimal 除法判断是否整除，避免浮点余数误判 */
  const units = value.div(CUSTOM_FACE_STEP_USD);
  if (!units.isInteger()) {
    return { ok: false, value, reason: `金额必须是 ${CUSTOM_FACE_STEP_USD} 的整数倍（如 1.25、3.02）` };
  }

  return { ok: true, value };
}

/** 把用户输入收敛到合法金额：向下取到最近的步长整数倍，并夹在 [0.01, MAX] 内。 */
export function snapToStep(input: DecimalInput): Decimal {
  let value: Decimal;
  try {
    value = dec(input);
  } catch {
    value = dec(0);
  }
  const steps = value.div(CUSTOM_FACE_STEP_USD).floor();
  const snapped = steps.times(CUSTOM_FACE_STEP_USD);
  if (snapped.lt(MIN_CUSTOM_FACE_USD)) return dec(MIN_CUSTOM_FACE_USD);
  if (snapped.gt(MAX_FACE_USD)) return dec(MAX_FACE_USD);
  return snapped;
}

/** 人类可读的步长提示，给前端 placeholder / 说明文案复用。 */
export const CUSTOM_FACE_HINT = `最小 ${CUSTOM_FACE_STEP_USD} USD，必须是 ${CUSTOM_FACE_STEP_USD} 的整数倍`;
