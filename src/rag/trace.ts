// src/rag/trace.ts
/**
 * 检索 trace：把 rag_search 每次调用的内部过程（各阶段耗时、通道命中量、错误、结果摘要）
 * 逐行追加到 JSONL，供离线分析检索质量与延迟（eval、回归对比、找出"哪些查询走了联网"）。
 *
 * 只记录 chunk_id / 来源 / 分数等元信息，不记录块正文，避免 trace 文件膨胀与敏感内容落盘。
 *
 * 环境变量（bootstrap 接线时读取）：
 *   RAG_TRACE=0        关闭（缺省开启；本地单行追加，一次检索一行）
 *   RAG_TRACE_DIR      trace 目录，缺省 <cwd>/.rag-cache/traces
 */
import fs from "node:fs";
import path from "node:path";

/** 一次检索的完整轨迹（落盘形态）；stages_ms 缺项表示该阶段未执行 */
export interface RagTraceEvent {
  ts: string;
  query: string;
  top_k: number;
  use_cache: boolean;
  /** execute 端到端耗时（毫秒） */
  latency_ms: number;
  stages_ms: {
    index?: number;
    lexical?: number;
    semantic?: number;
    rewrite?: number;
    second_pass?: number;
    web?: number;
    rerank?: number;
  };
  counts: {
    /** 词法通道命中块数 */
    lexical: number;
    /** 语义通道命中块数 */
    semantic: number;
    /** 重排前的候选池大小 */
    pool: number;
    /** 联网取回的文档数 */
    web_fetched: number;
    /** 最终返回条数 */
    results: number;
  };
  rewritten_query?: string;
  rerank_model?: string;
  errors?: { rewrite?: string; rerank?: string; vector?: string; web?: string };
  /** 最终结果的元信息摘要，按返回顺序；不含正文 */
  results: Array<{
    chunk_id: string;
    source: string;
    trust: string;
    origin: string;
    relevance_score: number;
    rerank_score?: number;
    similarity?: number;
  }>;
  /** execute 抛错时的错误信息；正常返回时没有这个字段 */
  error?: string;
}

/** record 的入参不含 ts（由 sink 统一打点）；完整事件见 RagTraceEvent */
export type RagTraceInput = Omit<RagTraceEvent, "ts">;

export interface RagTraceSink {
  record(event: RagTraceInput): void;
}

/**
 * JSONL 文件落盘。单行 appendFile 与 ingest_findings / TraceRecorder 同款，
 * 保证跨进程并发不写坏文件；写失败只静默关闭本次进程内的 trace（检索永远不该被观测拖垮）。
 */
export class FileRagTraceSink implements RagTraceSink {
  private readonly file: string;
  private dirReady = false;
  private broken = false;

  constructor(dir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(dir, "rag-search.jsonl");
  }

  /** 便于测试与离线分析：当前写哪个文件 */
  get filePath(): string {
    return this.file;
  }

  record(event: RagTraceInput): void {
    if (this.broken) return;
    try {
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      fs.appendFileSync(this.file, JSON.stringify({ ts: new Date(this.now()).toISOString(), ...event }) + "\n");
    } catch {
      this.broken = true;
    }
  }
}

/** bootstrap 接线用：RAG_TRACE=0 时不构造，其余按目录构造（目录写失败在首次 record 时才暴露并静默关闭） */
export function resolveRagTraceSinkFromEnv(env: NodeJS.ProcessEnv = process.env): RagTraceSink | undefined {
  if (env.RAG_TRACE?.trim() === "0") return undefined;
  const dir = env.RAG_TRACE_DIR?.trim() || path.join(process.cwd(), ".rag-cache", "traces");
  return new FileRagTraceSink(dir);
}
