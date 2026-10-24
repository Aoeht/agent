// src/core/scam_lexicon.ts
/**
 * 诈骗风险启发式词表：inspect_link（落地页采证）与 bili（弹幕/评论/字幕粗定位）共用。
 * 词表只做"值得看一眼"的定位，不是定性——误报交给模型权衡，漏报靠持续扩充。
 * 分类与权重：scam（诈骗套路语境）=3，contact（引流/联系方式）=2。
 */

/** 套路语境词：命中说明文本处在诈骗话术的语义场里 */
export const SCAM_KEYWORDS = [
  "退款", "理赔", "贷款", "征信", "解冻", "中奖", "刷单", "兼职",
  "安全账户", "退款通道", "验证身份", "保证金", "返利", "竞彩",
  // 视频平台语境补充：网赚/高薪招募/博彩/冒充公检法等
  "网赚", "日结", "高薪", "垫付", "佣金", "内幕", "稳赚", "包赚",
  "翻倍", "回血", "博彩", "六合彩", "外围", "戒赌", "校园贷",
  "公检法", "涉案", "洗钱", "冻结", "屏幕共享", "验证码",
] as const;

/** 引流/联系方式词：诈骗视频的核心动作是把人导去站外私域 */
export const CONTACT_KEYWORDS = [
  "加微信", "微信号", "加v", "+v", "vx", "v信", "威信", "加q", "加qq",
  "扣扣", "企鹅", "私信", "私聊", "看主页", "我主页", "主页简介", "简介有",
  "看简介", "网盘", "云盘", "提取码", "电报", "飞机", "接单", "上车",
  "进群", "加群", "内部群", "粉丝群", "扫码", "扫一扫", "二维码",
  "点击链接", "点击下方", "看置顶", "置顶评论", "联系方式", "招代理", "招募",
] as const;

/** 常见短链域名：目的地被隐藏是主要风险特征之一（inspect_link 同源；b23.tv 是 B 站自家短域） */
export const SHORT_LINK_HOSTS = new Set([
  "t.cn", "url.cn", "dwz.cn", "bit.ly", "tinyurl.com", "is.gd", "suo.im", "mrw.so", "t.im", "b23.tv",
]);

export type KeywordCategory = "scam" | "contact";

export interface KeywordHit {
  term: string;
  category: KeywordCategory;
  weight: number;
  /** 在文本中出现的次数 */
  count: number;
}

const WEIGHTS: Record<KeywordCategory, number> = { scam: 3, contact: 2 };

/** 单段文本的全部关键词命中（按词去重计数，大小写不敏感） */
export function scanKeywords(text: string): KeywordHit[] {
  const lower = text.toLowerCase();
  const hits: KeywordHit[] = [];
  const scan = (terms: readonly string[], category: KeywordCategory) => {
    for (const term of terms) {
      const count = countOccurrences(lower, term.toLowerCase());
      if (count > 0) hits.push({ term, category, weight: WEIGHTS[category], count });
    }
  };
  scan(SCAM_KEYWORDS, "scam");
  scan(CONTACT_KEYWORDS, "contact");
  return hits;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
