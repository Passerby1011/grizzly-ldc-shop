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
  ledger: { consumedUsd: string };
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

export interface KeyListView {
  keys: Array<{
    id: string;
    codePrefix: string;
    faceUsd: string;
    balanceUsd: string;
    status: string;
    note: string | null;
    outTradeNo: string | null;
    createdAt: string;
  }>;
  count: number;
}

export interface ReconcileView {
  ok: boolean;
  realUsd: string;
  ledgerUsd: string;
  driftUsd: string;
  allocatedUsd: string;
  availableUsd: string;
  source: string;
  message: string | null;
}
