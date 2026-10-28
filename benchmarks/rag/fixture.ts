// benchmarks/rag/fixture.ts
/**
 * rag_eval 自检（--self-check）用的密闭语料与假客户端：不联网、不落真实缓存，
 * BM25 + 主题 one-hot 假向量 + 确定性假重排/假改写，全部可复现。
 * 自检的定位是验证 eval 管线与指标数学本身，不是衡量真实检索质量（那是 --live 的活）。
 */
import path from "node:path";
import { KnowledgeStore, type KnowledgeInput } from "../../src/rag/knowledge_store";
import { tokenize } from "../../src/rag/tokenizer";
import type { EmbeddingClient } from "../../src/rag/embeddings";
import type { QueryRewriter } from "../../src/rag/rewrite";
import type { Reranker } from "../../src/rag/rerank";

/** 每个主题占向量的一维：文本命中该主题的词面就点亮对应维，L2 归一后算余弦 */
export const TOPICS = [
  "冒充客服退款",
  "刷单返利",
  "杀猪盘",
  "冒充公检法",
  "虚假贷款",
  "裸聊敲诈",
  "网络赌博",
  "ai换脸",
] as const;

const TOPIC_KEYWORDS: string[][] = [
  ["客服", "退款", "理赔", "屏幕共享", "安全账户"],
  ["刷单", "做任务", "返利", "佣金"],
  ["网恋", "交友", "投资", "杀猪盘", "带单"],
  ["公检法", "警察", "洗钱", "通缉", "资金审查"],
  ["贷款", "无抵押", "保证金", "提现", "解冻费"],
  ["裸聊", "录屏", "敲诈", "视频通话"],
  ["赌博", "投注", "博彩", "押注"],
  ["ai换脸", "换脸", "Deepfake", " Face"],
];

export function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector: number[] = TOPICS.map((_, i) => (TOPIC_KEYWORDS[i]!.some((k) => lower.includes(k.toLowerCase())) ? 1 : 0));
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export function makeFakeEmbeddings(): EmbeddingClient & { calls: string[][] } {
  const client = {
    model: "fake-embedding",
    calls: [] as string[][],
    async embed(inputs: string[]): Promise<number[][]> {
      client.calls.push([...inputs]);
      return inputs.map(fakeVector);
    },
  };
  return client;
}

/** 假重排器：按查询词元在候选文本中的出现比例打分（0~1），确定性且与相关性同向 */
export function makeFakeReranker(): Reranker {
  return {
    model: "fake-rerank",
    async rerank(query: string, documents: string[]): Promise<number[]> {
      const queryTokens = new Set(tokenize(query));
      return documents.map((doc) => {
        const tokens = tokenize(doc);
        if (tokens.length === 0) return 0;
        const hit = tokens.filter((t) => queryTokens.has(t)).length;
        return hit / tokens.length;
      });
    },
  };
}

const REWRITE_RULES: Array<[RegExp, string]> = [
  [/网恋|处对象|谈恋爱/g, "网络交友"],
  [/带你赚钱|带你投资|稳赚不赔|老师带单/g, "投资理财 杀猪盘"],
  [/给钱|打钱|转钱/g, "转账"],
  [/刷信誉|点赞赚钱|做任务/g, "刷单返利"],
];

/** 假改写器：按固定同义词表替换，无规则命中时原样返回（rag_search 会忽略与原查询相同的改写） */
export function makeFakeRewriter(): QueryRewriter {
  return {
    model: "fake-rewrite",
    async rewrite(query: string): Promise<string> {
      let next = query;
      for (const [pattern, replacement] of REWRITE_RULES) next = next.replace(pattern, replacement);
      return next;
    },
  };
}

export interface FixtureDoc {
  source: string;
  title: string;
  content: string;
}

export const FIXTURE_DOCS: FixtureDoc[] = [
  {
    source: "fixture://冒充客服退款诈骗",
    title: "冒充客服退款诈骗手法与防范",
    content:
      "冒充客服退款诈骗是高发的电信网络诈骗类型。骗子非法获取购物信息后，自称电商平台或快递公司客服，谎称商品有质量问题、快递丢失可以理赔，" +
      "诱导受害人下载会议软件开启屏幕共享，偷看验证码和密码，再以验证资金流水为由要求转账到所谓的安全账户。" +
      "防范要点：官方客服不会主动理赔，退款一定原路返回；绝不开启屏幕共享，绝不把验证码告诉任何人；接到此类电话直接挂断并拨打官方客服核实。" +
      "典型案例中，受害人被引导开启屏幕共享后，银行卡内的资金被悄悄转走，损失数万元。",
  },
  {
    source: "fixture://刷单返利诈骗",
    title: "刷单返利诈骗：小额返利是诱饵",
    content:
      "刷单返利诈骗以做任务返佣金为诱饵。骗子在群里发布点赞、刷信誉等小任务，先给小额返利骗取信任，随后要求垫资做大额连单任务，" +
      "以任务超时、操作失误为由拒绝返款，要求继续充值才能提现。" +
      "防范要点：刷单本身违法，所有要求垫资的刷单都是诈骗；小额返利是钓饵，大额连单是收割。",
  },
  {
    source: "fixture://杀猪盘诈骗",
    title: "杀猪盘：网络交友诱导投资理财",
    content:
      "杀猪盘诈骗从网络交友开始。骗子伪装成成功人士与受害人建立恋爱关系，取得信任后以内部消息、老师带单为由诱导其在虚假平台投资理财，" +
      "前期小额盈利可正常提现，加大投入后平台无法提现，客服失联。" +
      "防范要点：网恋对象推荐的投资理财都是诈骗；正规投资平台受监管，不存在稳赚不赔的内部消息。",
  },
  {
    source: "fixture://冒充公检法诈骗",
    title: "冒充公检法诈骗：资金审查是幌子",
    content:
      "冒充公检法诈骗中，骗子自称警察或检察官，谎称受害人涉嫌洗钱、名下电话卡发送诈骗短信，出示伪造的通缉令制造恐慌，" +
      "要求把资金转入所谓的安全账户配合资金审查，并要求绝对保密、断绝与外界联系。" +
      "防范要点：公检法机关不会通过电话办案，不存在安全账户，不会要求转账验证资金；凡是要保密的都是骗子。",
  },
  {
    source: "fixture://虚假贷款诈骗",
    title: "虚假贷款诈骗：永远无法提现的额度",
    content:
      "虚假贷款诈骗以无抵押、低利息、快速放款为诱饵。受害人填写申请后，骗子以解冻费、保证金、银行流水验证等名义要求先交钱，" +
      "交钱后仍无法提现，对方继续以征信包装费等名目索取费用。" +
      "防范要点：正规贷款放款前不收取任何费用；无抵押低息贷款广告基本都是诈骗。",
  },
  {
    source: "fixture://裸聊敲诈",
    title: "裸聊敲诈：录屏后的勒索链条",
    content:
      "裸聊敲诈中，骗子诱导受害人进行视频通话并秘密录屏，随后以把不雅视频发给通讯录好友为威胁，反复勒索钱财，" +
      "第一次转账后勒索金额会不断加码。" +
      "防范要点：不与陌生网友进行裸聊；被敲诈后保留证据立即报警，不要转账息事宁人。",
  },
  {
    source: "fixture://网络赌博诈骗",
    title: "网络赌博：虚假平台操纵输赢",
    content:
      "网络赌博平台由骗子后台操纵赔率与输赢，前期让赌客小赢可提现，大额充值后以账户异常为由拒绝出金，" +
      "甚至以代理返佣诱导发展下线。" +
      "防范要点：网络赌博是违法行为，所有能赢钱的赌博网站都是骗子开的；沾上赌博，倾家荡产。",
  },
  {
    source: "fixture://ai换脸诈骗",
    title: "AI换脸诈骗：眼见未必为实",
    content:
      "AI换脸诈骗利用深度伪造技术冒充受害人的领导或亲友，通过视频通话借钱、要求财务转账。人脸可以伪造，声音也可以克隆，" +
      "眼见为实在AI时代不再成立。" +
      "防范要点：视频通话中的借钱请求也要当面或多渠道核实；可要求对方做转头、按鼻子等交互动作验证真伪。",
  },
];

/** 自检用 gold：source 按"子串匹配"对上 fixture 文档；goldTerms 必须真实出现在该文档文本里 */
export interface FixtureCase {
  id: string;
  query: string;
  goldSources: string[];
  goldTerms: string[];
  notes?: string;
}

export const FIXTURE_CASES: FixtureCase[] = [
  { id: "kefu-tuikuan", query: "客服说商品有问题给我退款还要开屏幕共享", goldSources: ["冒充客服退款诈骗"], goldTerms: ["屏幕共享", "安全账户"] },
  { id: "shuadan-fanli", query: "群里做任务给佣金先返了几十块", goldSources: ["刷单返利诈骗"], goldTerms: ["刷单", "返利"] },
  { id: "shazhupan", query: "网上认识的对象带我投资理财稳赚不赔", goldSources: ["杀猪盘诈骗"], goldTerms: ["杀猪盘", "投资理财"] },
  { id: "gongjianfa", query: "警察打电话说我涉嫌洗钱要转钱到安全账户审查", goldSources: ["冒充公检法诈骗"], goldTerms: ["安全账户", "资金审查"] },
  { id: "daikuan", query: "无抵押贷款没放款先让我交保证金", goldSources: ["虚假贷款诈骗"], goldTerms: ["保证金", "无抵押"] },
  { id: "luoliao", query: "视频通话被录下来对方威胁发给我朋友", goldSources: ["裸聊敲诈"], goldTerms: ["裸聊", "敲诈"] },
  { id: "dubo", query: "赌博网站前期让赢点后来不让提现", goldSources: ["网络赌博诈骗"], goldTerms: ["赌博", "提现"] },
  { id: "aihuanlian", query: "领导的视频通话让我紧急转账", goldSources: ["ai换脸诈骗"], goldTerms: ["AI换脸", "视频通话"] },
];

/** 密闭知识库：临时目录里的 JSON 文件后端，语料全部 internal trust，不受 TTL 影响 */
export async function createFixtureStore(rootDir: string): Promise<KnowledgeStore> {
  const inputs: KnowledgeInput[] = FIXTURE_DOCS.map((doc) => ({
    source: doc.source,
    title: doc.title,
    content: doc.content,
    trust: "internal" as const,
  }));
  const store = new KnowledgeStore({ filePath: path.join(rootDir, "knowledge.json") });
  await store.upsert(inputs);
  return store;
}
