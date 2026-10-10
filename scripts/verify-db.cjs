// 独立验收脚本：只打印非敏感信息 + 真实连库查询
const { PrismaClient } = require("@prisma/client");

function mask(u) {
  try {
    const url = new URL(u);
    return {
      HOST: url.hostname,
      DB: url.pathname.replace(/^\//, ""),
      USER: url.username,
      POOLED: url.hostname.includes("-pooler"),
      PARAMS: url.search,
    };
  } catch (e) {
    return { ERROR: "URL 解析失败: " + e.message };
  }
}

(async () => {
  console.log("=== 非敏感连接信息 ===");
  console.log(mask(process.env.DATABASE_URL));

  const prisma = new PrismaClient();
  try {
    console.log("=== 真实连库测试 ===");
    const tables = await prisma.$queryRaw`
      select table_name from information_schema.tables
      where table_schema = 'public' order by 1`;
    console.log("  表数量:", tables.length);
    console.log("  表清单:", tables.map((t) => t.table_name).join(", "));

    const c = await prisma.$queryRaw`select count(*)::int as c from "CardKey"`;
    console.log("  CardKey 行数 =", c[0].c);

    const g = await prisma.$queryRaw`select count(*)::int as c from "GrizzlySnapshot"`;
    console.log("  GrizzlySnapshot 行数 =", g[0].c);
  } catch (e) {
    console.log("  连库失败:", String(e.message).slice(0, 500));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
