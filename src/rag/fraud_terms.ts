// src/rag/fraud_terms.ts
/**
 * 反诈语料的语义闸门：哪些文本算"诈骗案例材料"。
 * 清理（prune_corpus）与灌入（ingest_cases）共用这一份，避免两个口径互相漂移。
 * 简繁中文都要列：官方来源里繁体（「虛假投資平台名單」）很常见，只写简体会把它当无关内容删掉。
 */
export const FRAUD_TERMS = [
  "诈骗", "詐騙", "欺詐", "欺诈", "反诈", "反詐", "涉诈", "涉詐", "电诈", "電詐", "骗", "騙",
  "刷单", "刷單", "杀猪盘", "殺豬盤", "资金盘", "資金盤", "非法集资", "非法集資", "投资平台", "投資平台",
  "博彩", "赌博", "賭博", "裸聊", "钓鱼", "釣魚", "木马", "木馬", "汇款", "匯款", "转账", "轉賬",
  "验证码", "驗證碼", "银行卡", "銀行卡", "客服", "退款", "冒充", "仿冒", "盗刷", "盜刷",
  "洗钱", "洗錢", "引流", "诱导", "誘導", "暗网", "暗網", "风控", "風控", "冻结", "凍結",
  "报案", "報案", "判决", "判決", "起诉", "起訴", "告破", "高风险", "高風險", "套路",
  "scam", "fraud", "phishing", "malicious", "spam", "ponzi", "blacklist", "blocklist",
  "money mule", "threat intel", "reputation", "impersonat",
];

const PATTERN = new RegExp(
  FRAUD_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi"
);

export function fraudHits(text: string): number {
  return (text.match(PATTERN) ?? []).length;
}

/** 文档级判定：标题 + 正文前 8000 字里命中次数达到门槛才算反诈材料 */
export function docIsFraudRelated(title: string | undefined, body: string, minHits = 1): boolean {
  return fraudHits(`${title ?? ""} ${body.slice(0, 8_000)}`) >= minHits;
}
