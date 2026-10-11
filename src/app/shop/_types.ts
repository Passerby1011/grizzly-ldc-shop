export interface SessionView {
  keyId: string;
  maskedCode: string;
  codePrefix: string;
  balanceUsd: string;
  faceUsd: string;
  status: string;
  expiresAt: string | null;
}

export interface CountryView {
  id: number;
  eng: string;
  chn?: string;
  rus?: string;
  visible: number;
  /** 服务端算好的展示名（上游 chn → 本地补齐表 → eng）。优先用它，别在前端重算。 */
  name?: string;
}

export interface ServiceView {
  code: string;
  name: string;
}

export interface QuoteView {
  service: string;
  country: string;
  priceUsd: string;
  source: string;
  available: number | null;
  sellable: boolean | null;
  maxPriceUsd: string;
  disclaimer: string;
}

export interface ActivationView {
  activationId: string;
  phone: string;
  service: string;
  country: string;
  reservedUsd: string;
  costUsd: string;
  priceSource: string;
  balanceUsd: string;
}

export type ActivationStatus = "waiting" | "ok" | "cancelled" | "expired";

export interface PollView {
  activationId: string;
  status: ActivationStatus;
  code: string | null;
  smsText: string | null;
  phone: string;
  hint: string | null;
  costUsd: string | null;
  balanceUsd: string | null;
  /** 距「可取消」的剩余秒数（<=0 表示现在就能取消）。 */
  cancelAvailableInSeconds: number;
  /** 可取消的时间点（ISO 时间戳）。 */
  cancelLockedUntil: string;
}

export interface OrderQueryView {
  outTradeNo: string;
  status: string;
  faceUsd: string;
  amountLdc: string;
  code: string | null;
  codePrefix: string;
  codeExpired: boolean;
  justIssued: boolean;
  warnings: string[];
}

export interface MeView {
  key: {
    id: string;
    codePrefix: string;
    faceUsd: string;
    balanceUsd: string;
    status: string;
    expiresAt: string | null;
    /** 是否仍可用（过期/作废的卡不能再取号） */
    usable?: boolean;
  } | null;
  /** 该卡密的取号历史（倒序）。刷新页面后靠它恢复"我用过什么"。 */
  activations: Array<{
    id: string;
    grizzlyId: string;
    service: string;
    country: string;
    phone: string;
    status: string;
    code: string | null;
    reservedUsd: string;
    costUsd: string | null;
    createdAt: string;
    closedAt: string | null;
  }>;
  /** 资金流水（倒序）：买卡/充值/取号/退款一目了然。 */
  ledger: Array<{
    id: string;
    deltaUsd: string;
    balanceAfter: string;
    reason: string;
    refId: string | null;
    createdAt: string;
  }>;
}
