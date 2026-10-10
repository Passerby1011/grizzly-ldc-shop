import { requireAdmin } from "@/lib/admin";
import { getPrisma } from "@/lib/db";
import { badRequest, getSearchParams, withRoute } from "@/lib/http";
import { dec } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 导出上限：一次最多 5000 行，够日常对账；更多请分页拉。 */
const EXPORT_LIMIT = 5000;

type CsvCell = string | number | null | undefined;

/** RFC 4180 转义：含分隔符/引号/换行时用双引号包裹，内部引号翻倍。 */
function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // BOM：Excel 打开 UTF-8 CSV 不乱码
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * CSV 导出：`?type=keys|orders|activations|ledger`。
 *
 * 刻意不导出卡密明文——明文只在签发那一刻展示一次，导出等于变相长期留存。
 */
export const GET = withRoute(async (request: Request) => {
  requireAdmin(request);
  const type = (getSearchParams(request).get("type") || "").trim();
  const prisma = getPrisma();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  if (type === "keys") {
    const rows = await prisma.cardKey.findMany({
      orderBy: { createdAt: "desc" },
      take: EXPORT_LIMIT,
      include: { order: { select: { outTradeNo: true } } },
    });
    return csvResponse(
      `keys-${stamp}.csv`,
      toCsv(
        ["id", "codePrefix", "faceUsd", "balanceUsd", "status", "note", "outTradeNo", "createdAt", "expiresAt"],
        rows.map((k) => [
          k.id,
          k.codePrefix,
          dec(k.faceUsd.toString()).toFixed(2),
          dec(k.balanceUsd.toString()).toFixed(2),
          k.status,
          k.note,
          k.order?.outTradeNo ?? null,
          k.createdAt.toISOString(),
          k.expiresAt ? k.expiresAt.toISOString() : null,
        ]),
      ),
    );
  }

  if (type === "orders") {
    const rows = await prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: EXPORT_LIMIT,
      include: { key: { select: { codePrefix: true } } },
    });
    return csvResponse(
      `orders-${stamp}.csv`,
      toCsv(
        ["id", "outTradeNo", "ldcTradeNo", "gateway", "name", "amountLdc", "faceUsd", "status", "keyPrefix", "paidAt", "createdAt"],
        rows.map((o) => [
          o.id,
          o.outTradeNo,
          o.ldcTradeNo,
          o.gateway,
          o.name,
          dec(o.amountLdc.toString()).toFixed(2),
          dec(o.faceUsd.toString()).toFixed(2),
          o.status,
          o.key?.codePrefix ?? null,
          o.paidAt ? o.paidAt.toISOString() : null,
          o.createdAt.toISOString(),
        ]),
      ),
    );
  }

  if (type === "activations") {
    const rows = await prisma.activation.findMany({
      orderBy: { createdAt: "desc" },
      take: EXPORT_LIMIT,
      include: { key: { select: { codePrefix: true } } },
    });
    return csvResponse(
      `activations-${stamp}.csv`,
      toCsv(
        ["id", "keyPrefix", "grizzlyId", "service", "country", "phone", "reservedUsd", "costUsd", "status", "createdAt", "closedAt"],
        rows.map((a) => [
          a.id,
          a.key?.codePrefix ?? null,
          a.grizzlyId,
          a.service,
          a.country,
          a.phone,
          dec(a.reservedUsd.toString()).toFixed(2),
          a.costUsd ? dec(a.costUsd.toString()).toFixed(2) : null,
          a.status,
          a.createdAt.toISOString(),
          a.closedAt ? a.closedAt.toISOString() : null,
        ]),
      ),
    );
  }

  if (type === "ledger") {
    const rows = await prisma.keyLedger.findMany({
      orderBy: { createdAt: "desc" },
      take: EXPORT_LIMIT,
      include: { key: { select: { codePrefix: true } } },
    });
    return csvResponse(
      `ledger-${stamp}.csv`,
      toCsv(
        ["id", "keyId", "keyPrefix", "deltaUsd", "balanceAfter", "reason", "refId", "createdAt"],
        rows.map((e) => [
          e.id,
          e.keyId,
          e.key?.codePrefix ?? null,
          dec(e.deltaUsd.toString()).toFixed(2),
          dec(e.balanceAfter.toString()).toFixed(2),
          e.reason,
          e.refId,
          e.createdAt.toISOString(),
        ]),
      ),
    );
  }

  throw badRequest("type 必须是 keys / orders / activations / ledger 之一");
});
