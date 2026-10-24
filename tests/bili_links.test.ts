// tests/bili_links.test.ts
// 链接候选提取：常规 URL/域名、短链、中文混淆变体、误报抑制、同主机去重
// 运行: bun test ./tests/bili_links.test.ts
import { test, expect } from "bun:test";
import { extractLinks } from "../src/bili/links";

test("常规 URL、域名与短链", () => {
  const links = extractLinks(
    "详情 https://example.com/a?b=1。或 www.foo-bar.top/x，短链 t.cn/AbCdEf 和 b23.tv/xyz",
    "danmaku",
  );
  const byHost = new Map(links.map((l) => [l.normalized, l]));
  expect(byHost.get("example.com/a?b=1")?.kind).toBe("url");
  expect(byHost.get("www.foo-bar.top/x")?.kind).toBe("domain");
  expect(byHost.get("t.cn/abcdef")?.short).toBe(true); // normalized 统一小写，原文大小写保留在 raw
  expect(byHost.get("t.cn/abcdef")?.raw).toBe("t.cn/AbCdEf");
  expect(byHost.get("b23.tv/xyz")?.short).toBe(true);
  // URL 与裸域名同主机：只留更完整的 URL 形态
  expect(links.filter((l) => l.normalized.startsWith("example.com"))).toHaveLength(1);
  for (const link of links) expect(link.source).toBe("danmaku");
});

test("混淆变体：中文句号当点、空格拆分、括号 dot", () => {
  const links = extractLinks("看主页 2048点vip 或 example 点 com 领取", "comment");
  const byHost = new Map(links.map((l) => [l.normalized, l]));
  expect(byHost.get("2048.vip")?.kind).toBe("obfuscated");
  expect(byHost.get("example.com")?.kind).toBe("obfuscated");
});

test("误报抑制：版本号、无链接中文、TLD 边界", () => {
  expect(extractLinks("版本号 1.2.3，这句话没有链接", "t")).toHaveLength(0);
  expect(extractLinks("not.commercial 不是链接", "t")).toHaveLength(0);
  const punct = extractLinks("快看 https://example.com/a。", "t");
  expect(punct).toHaveLength(1);
  expect(punct[0]!.normalized).toBe("example.com/a");
});

test("二级域名与路径：host 去重保留更强证据", () => {
  const links = extractLinks("主站 example.com 备用 www.example.com/register", "desc");
  expect(links).toHaveLength(1);
  expect(links[0]!.normalized).toBe("www.example.com/register");
  expect(links[0]!.kind).toBe("domain");
});
