// src/rag/ingest_cases.ts
/**
 * 反诈案例灌入 CLI：按检索词找权威来源页面 → 语义与篇幅闸门 → 幂等入库。
 *
 *   bun run rag:cases            默认补到 120 篇
 *   bun run rag:cases 200        补到 200 篇
 *
 * 两条纪律：
 * 1. 域名白名单硬编码在下面（政务/法院/检察/反诈/官媒）。不加白名单就会灌进
 *    "最新域名1024"那类 SEO 页，把召回质量拉垮——这是本项目的实测教训。
 * 2. 入库用的是 trust="web"，默认 7 天 TTL，下次写入就会把这批案例扫掉。
 *    长期留存请在 .env 设 AGENT_RAG_TTL_DAYS=365。
 *
 * 幂等：source 是文档主键的一部分，已入库的 URL 直接跳过，可反复补跑。
 */
import { createKnowledgeStore } from "./store_factory";
import { closePgPools } from "./pg_store";
import { fraudHits } from "./fraud_terms";
import { tavilySearch } from "../tools/tavily_client";
import { htmlToText } from "../tools/inspect_link";

const args = process.argv.slice(2);
const TARGET = Number.parseInt(args.find((a) => !a.startsWith("--")) ?? "120", 10);
const PER_QUERY = 8;

/** 只收权威来源，其余域名一律不入库 */
const ALLOW_HOSTS = [
  "gov.cn", "chinacourt.org", "12321.cn", "gov.hk", "gov.mo",
  "xinhuanet.com", "news.cn", "people.com.cn", "cctv.com", "thepaper.cn",
  "cnr.cn", "legaldaily.com.cn", "fazhi.net",
];

/** 检索词覆盖常见手法 + 罪名 + 通报口径；补跑时可以在这里加新词 */
const QUERIES = [
  "公安部 打击 电信网络诈骗 典型案例 通报",
  "最高人民检察院 诈骗 典型案例 发布",
  "人民法院 电信网络诈骗 判决 案例",
  "刷单返利 诈骗 案例 警方 通报",
  "虚假投资理财 杀猪盘 诈骗 案例",
  "冒充电商客服 退款理赔 诈骗 案例",
  "冒充公检法 诈骗 案例 警方 提示",
  "网络贷款 诈骗 先交手续费 案例",
  "帮信罪 卡农 转账 洗钱 判决 案例",
  "跑分 平台 支付结算 犯罪 案例",
  "裸聊敲诈 诈骗 案例 通报",
  "游戏交易 虚假 低价 装备 诈骗 案例",
  "虚假购物 服务 诈骗 公安部 集群战役",
  "AI 换脸 声音克隆 诈骗 案例",
  "共享屏幕 诈骗 案例 提示",
  "虚假 贷款 App 下载 诈骗 案例",
  "数字货币 虚拟币 投资 诈骗 判决",
  "资金盘 传销 庞氏 案例 判决",
  "养老 公寓 预付费 诈骗 案例",
  "助学金 资助 冒充老师 诈骗 案例",
  "网课退费 诈骗 案例 通报",
  "信用卡 套现 虚假 提额 诈骗 案例",
  "跨境电商 刷单 诈骗 案例",
  "境外 高薪 招聘 诈骗 偷渡 案例",
  "虚假 博彩 平台 引流 诈骗 案例",
  "仿冒 官网 恶意 App 下载 诈骗 通报",
  "ETC 短信 链接 诈骗 案例",
  "医保 社保 停用 链接 诈骗 案例",
  "中奖 红包 领取 诈骗 案例",
  "校园贷 培训贷 诈骗 案例",
  "冒充 领导 微信 诈骗 判决 案例",
  "误开会员 扣费 客服 诈骗 案例",
  "机票 退改签 理赔 诈骗 案例",
  "快递 丢失 赔付 扫码 诈骗 案例",
  "演唱会 门票 虚假 交易 诈骗 案例",
  "二手 交易平台 脱离 担保 诈骗 案例",
  "婚恋 平台 诱导 投资 诈骗 案例",
  "虚拟货币 搬砖套利 诈骗 判决",
  "解冻费 税费 贷款 诈骗 案例",
  "征信 修复 诈骗 案例 通报",
  "燃气 供暖 缴费 群 诈骗 案例",
  "冒充 老师 收 学费 群 诈骗",
  "兼职 手工活 押金 诈骗 案例",
  "游戏 皮肤 未成年人 诈骗 案例",
  "直播 打赏 退费 诈骗 案例",
  "帮助信息网络犯罪活动罪 典型 判决",
  "掩饰 隐瞒 犯罪所得 电诈 判决",
  "两高 诈骗罪 司法解释 典型案例",
  "国家反诈中心 预警 拦截 案例 通报",
  "12321 举报 涉诈 网址 通报",
  "缅北 电诈 遣返 判决 案例",
  "妙瓦底 诈骗 园区 案例",
  "银行卡 盗刷 跨境 诈骗 案例",
  "养老 理财 保健品 诈骗 判决",
  "传销 民族资产 解冻 案例",
];

function allowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOW_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

/** Tavily 没给正文时的兜底抓取：只接 HTML，PDF 交给上游 rawContent */
async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) return "";
    return htmlToText((await response.text()).slice(0, 2_000_000));
  } catch {
    return "";
  }
}

const store = createKnowledgeStore();
const existing = new Set((await store.list()).map((d) => d.source));
console.log(`起点：${existing.size} 文档｜目标新增 ${TARGET} 篇｜检索词 ${QUERIES.length} 组`);

const seen = new Set<string>();
const pending: { source: string; title: string; content: string }[] = [];
const skipped = { notAllowed: 0, duplicate: 0, thin: 0, fetched: 0 };
let ingested = 0;
let searchCalls = 0;

async function flush(): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  const saved = await store.upsert(batch.map((item) => ({ ...item, trust: "web" as const })));
  ingested += saved.length;
  for (const doc of saved) console.log(`  + ${String(doc.chunks.length).padStart(2)} 片 ${doc.source.slice(0, 96)}`);
}

for (const query of QUERIES) {
  if (ingested + pending.length >= TARGET) break;
  let response;
  try {
    response = await tavilySearch({ query, maxResults: PER_QUERY, includeRawContent: true, timeoutMs: 30_000 });
    searchCalls++;
  } catch (error) {
    console.warn(`  跳过检索「${query}」：${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  for (const result of response.results) {
    const url = result.url.trim();
    if (seen.has(url) || existing.has(url)) {
      skipped.duplicate++;
      continue;
    }
    if (!allowed(url)) {
      skipped.notAllowed++;
      continue;
    }
    seen.add(url);
    let body = (result.rawContent ?? "").trim();
    if (body.includes("<") && body.includes(">")) body = htmlToText(body);
    if (body.length < 600) {
      body = await fetchText(url);
      skipped.fetched++;
    }
    if (body.length < 600 || fraudHits(`${result.title} ${body.slice(0, 8_000)}`) < 2) {
      skipped.thin++;
      continue;
    }
    pending.push({ source: url, title: (result.title || url).slice(0, 200), content: body });
    if (pending.length >= 12) await flush();
    if (ingested + pending.length >= TARGET) break;
  }
  console.log(`检索「${query.slice(0, 24)}」→ 累计候选 ${ingested + pending.length}`);
}
await flush();
console.log(`\n完成：新增 ${ingested} 文档（Tavily ${searchCalls} 次）｜跳过 非白名单 ${skipped.notAllowed} / 重复 ${skipped.duplicate} / 正文不足 ${skipped.thin}（自抓 ${skipped.fetched}）`);
const final = await store.list();
console.log(`当前库：${final.length} 文档 / ${final.reduce((n, d) => n + d.chunks.length, 0)} 分片 / revision ${store.revision}`);
await closePgPools();
process.exit(0);
