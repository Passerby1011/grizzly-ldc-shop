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
  } | null;
  activations: Array<{
    id: string;
    service: string;
    country: string;
    phone: string;
    status: string;
    code: string | null;
    costUsd: string | null;
    createdAt: string;
  }>;
}
