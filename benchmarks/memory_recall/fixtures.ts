/** 合成语料，不读取用户的真实会话。期望证据独立于检索分数。 */
export interface RecallFixtureSession {
  id: string;
  name: string;
  summaries: string[];
}

export interface RecallFixtureCase {
  id: string;
  category: string;
  query: string;
  excludeSessionId?: string;
  expected: Array<{ sessionId: string; alternativeSessionIds?: string[]; evidence: string }>;
}

export const sessions: RecallFixtureSession[] = [
  { id: "boundary", name: "跨块编号", summaries: [
    "背景".repeat(247) + " BOUNDARY731 的修复动作是清理临时锁文件。",
  ] },
  { id: "incident", name: "连接池故障复盘", summaries: [
    `## 背景\n${Array.from({ length: 140 }, (_, i) => `样本 ${i}：归档影像的像素亮度与相机曝光参数仅供背景分析，不参与故障决策。`).join("\n")}\n## 最终结论\n故障 QX942 的修复是重建连接池，禁止通过重启整个集群处理。`,
  ] },
  { id: "release", name: "发布步骤", summaries: [
    "## 数据保护\n每次上线前创建数据库快照，备份保留七天。\n## 验证\n发布完成后运行健康探针，失败则回滚。\n## 通知\n发布通知发给值班负责人。",
  ] },
  { id: "preferences", name: "纯聊天偏好", summaries: [
    "## 用户偏好\n用户明确要求回答先给结论，再列依据；提交信息使用中文。\n## 工作约束\n周五下午不安排上线。",
  ] },
  { id: "tracker", name: "看板迁移", summaries: [
    "历史仪表盘地址是 https://old.example.invalid/metrics，代号 legacyboard。",
    "## 当前资源\n性能看板已迁移到 https://new.example.invalid/metrics，代号 metricshub。",
  ] },
  { id: "mixed", name: "多主题讨论", summaries: [
    "## 图像标注\n图像审核采用两名标注员交叉复核。\n## 搜索存储\n向量索引迁移到 PostgreSQL，扩展名为 pgvector。\n## 文档约定\n发布文档中必须附带版本变更表。",
  ] },
  { id: "security", name: "密钥轮换", summaries: [
    "## 安全决策\n服务凭据每三十天轮换，轮换后撤销旧凭据。",
  ] },
  { id: "archive", name: "归档策略", summaries: [
    "## 留存期限\n访问日志保留九十天，到期从存储桶删除。",
  ] },
  { id: "previous", name: "之前的限流处理", summaries: [
    "## 修复结论\n接口限流采用指数退避，最多重试三次。",
  ] },
  { id: "current", name: "当前会话", summaries: [
    "## 进行中\n接口限流采用指数退避，本会话尚未验证，继续观察。",
  ] },
  { id: "ticket", name: "工单归属", summaries: [
    "## 跟踪\n工单 ALPHA731 由数据组处理，验收联系人是小林。",
  ] },
  { id: "duplicate-release", name: "重复发布笔记", summaries: [
    "## 数据保护\n每次上线前创建数据库快照，备份保留七天。",
  ] },
];

export const cases: RecallFixtureCase[] = [
  { id: "chunk-boundary", category: "跨块编号", query: "BOUNDARY731", expected: [{ sessionId: "boundary", evidence: "清理临时锁文件" }] },
  { id: "tail-id", category: "长摘要尾部", query: "QX942", expected: [{ sessionId: "incident", evidence: "重建连接池" }] },
  { id: "exact-ticket", category: "精确标识符", query: "ALPHA731", expected: [{ sessionId: "ticket", evidence: "小林" }] },
  { id: "english-term", category: "中英混合", query: "pgvector PostgreSQL", expected: [{ sessionId: "mixed", evidence: "向量索引迁移到 PostgreSQL" }] },
  { id: "paraphrase-backup", category: "跨语言改写", query: "save a database snapshot before rollout", expected: [
    { sessionId: "release", alternativeSessionIds: ["duplicate-release"], evidence: "备份保留七天" },
  ] },
  { id: "paraphrase-security", category: "同义改写", query: "更换认证令牌的周期", expected: [{ sessionId: "security", evidence: "每三十天轮换" }] },
  { id: "preference-chat", category: "纯聊天沉淀", query: "回答 结论 依据", expected: [{ sessionId: "preferences", evidence: "先给结论" }] },
  { id: "schedule", category: "约束记忆", query: "周五 下午 上线", expected: [{ sessionId: "preferences", evidence: "周五下午不安排上线" }] },
  { id: "latest-resource", category: "最新摘要", query: "metricshub", expected: [{ sessionId: "tracker", evidence: "https://new.example.invalid/metrics" }] },
  { id: "mixed-topic", category: "多主题定位", query: "图像 标注 复核", expected: [{ sessionId: "mixed", evidence: "两名标注员交叉复核" }] },
  { id: "retention", category: "数字事实", query: "访问日志 保留", expected: [{ sessionId: "archive", evidence: "九十天" }] },
  { id: "exclude-current", category: "排除当前会话", query: "接口限流 指数退避", excludeSessionId: "current", expected: [{ sessionId: "previous", evidence: "最多重试三次" }] },
  { id: "two-sections", category: "多证据召回", query: "发布 健康探针 值班负责人", expected: [
    { sessionId: "release", evidence: "运行健康探针" }, { sessionId: "release", evidence: "值班负责人" },
  ] },
  { id: "unrelated", category: "无关问题", query: "火星轨道偏心率", expected: [] },
  { id: "stale", category: "过期摘要", query: "legacyboard", expected: [] },
  { id: "blank", category: "空查询", query: "   ", expected: [] },
];

/** 仅供机制自检的概念向量；不读取 qrels，也不是实际模型质量的替代。 */
const concepts = [
  // 工单标识符故意不设语义维度：验证 BM25 能补上向量对精确编号的漏召回。
  ["像素", "曝光", "相机"], ["qx942", "连接池"], ["pgvector", "postgresql", "向量索引"],
  ["快照", "备份", "database", "snapshot", "rollout"], ["凭据", "轮换", "认证令牌", "更换"],
  ["回答", "结论", "依据", "提交信息"], ["周五", "下午"], ["metricshub"],
  ["图像", "标注", "复核"], ["访问日志", "九十天"], ["限流", "退避"],
  ["健康探针", "回滚"], ["值班负责人", "发布通知"],
];

export function mockVector(text: string): number[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  return concepts.map((terms) => terms.reduce((sum, term) => sum + normalized.split(term).length - 1, 0));
}
