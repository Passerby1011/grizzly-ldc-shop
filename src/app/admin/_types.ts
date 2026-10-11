/** 管理台视图类型。字段名与 API 响应保持一致（金额一律字符串，前端不做浮点运算）。 */

export interface PoolView {
  realBalanceUsd: string;
  allocatedUsd: string;
  safetyBufferUsd: string;
  availableUsd: string;
  source: string;
  degraded: boolean;
  observedAt: string | null;
}

export interface OverviewView {
  pool: PoolView;
  ledger: { consumedUsd: string; netConsumedUsd: string; manualAdjustedUsd: string };
  cards: { byStatus: Record<string, number>; total: number };
  orders: {
    byStatus: Record<string, number>;
    total: number;
    paidAmountLdc: string;
    paidFaceUsd: string;
  };
  activations: { byStatus: Record<string, number>; total: number };
  lastReconcile: {
    ok: boolean;
    realUsd: string;
    ledgerUsd: string;
    driftUsd: string;
    message: string | null;
    createdAt: string;
  } | null;
  lastSnapshot: {
    realBalanceUsd: string;
    allocatedUsd: string;
    availableUsd: string;
    activeCount: number;
    createdAt: string;
  } | null;
  recentOrders: Array<{
    id: string;
    outTradeNo: string;
    name: string;
    status: string;
    faceUsd: string;
    amountLdc: string;
    keyId: string | null;
    paidAt: string | null;
    createdAt: string;
  }>;
  recentActivations: Array<{
    id: string;
    grizzlyId: string;
    service: string;
    country: string;
    phone: string;
    status: string;
    code: string | null;
    costUsd: string | null;
    createdAt: string;
  }>;
}

export interface IssuedKeyView {
  id: string;
  code: string;
  codePrefix: string;
  faceUsd: string;
}

export interface IssueKeysView {
  keys: IssuedKeyView[];
  totalFaceUsd: string;
  pool: PoolView;
  notice: string;
}

/** 分页信封：所有列表接口统一这个形状。 */
export interface Paged<T> {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface KeyRow {
  id: string;
  codePrefix: string;
  faceUsd: string;
  balanceUsd: string;
  status: string;
  note: string | null;
  outTradeNo: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export type KeyListView = Paged<never> & { keys: KeyRow[] };

export interface OrderRow {
  id: string;
  outTradeNo: string;
  ldcTradeNo: string | null;
  gateway: string;
  name: string;
  amountLdc: string;
  faceUsd: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  keyPrefix: string | null;
  keyStatus: string | null;
  /** purchase = 新购；topup = 充值 */
  kind: string;
  /** 充值订单的目标卡密（新购为 null） */
  targetKeyPrefix: string | null;
  targetKeyStatus: string | null;
}

export type OrderListView = Paged<never> & { orders: OrderRow[] };

export interface ActivationRow {
  id: string;
  keyPrefix: string | null;
  grizzlyId: string;
  service: string;
  country: string;
  phone: string;
  reservedUsd: string;
  costUsd: string | null;
  status: string;
  hasCode: boolean;
  createdAt: string;
  closedAt: string | null;
}

export type ActivationListView = Paged<never> & { activations: ActivationRow[] };

export interface LedgerRow {
  id: string;
  keyId: string;
  keyPrefix: string | null;
  deltaUsd: string;
  balanceAfter: string;
  reason: string;
  refId: string | null;
  createdAt: string;
}

export type LedgerListView = Paged<never> & { entries: LedgerRow[] };

/** 设置面板：生效值 / 环境变量回退值 / 库里显式覆盖了哪些键。 */
export interface SiteSettingsValues {
  rateLdcPerUsd: string;
  markupPct: number;
  cancelLockSeconds: number;
  safetyBufferUsd: string;
  faceValuePresets: number[];
}

export interface SettingsView {
  effective: SiteSettingsValues;
  envFallback: SiteSettingsValues;
  fromDb: Record<string, string>;
  hints: Record<string, string>;
}

export interface ReconcileView {
  ok: boolean;
  realUsd: string;
  ledgerUsd: string;
  driftUsd: string;
  baselineUsd: string;
  netConsumedUsd: string;
  manualAdjustedUsd: string;
  allocatedUsd: string;
  availableUsd: string;
  source: string;
  message: string | null;
}
