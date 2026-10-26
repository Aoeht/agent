# scanner 评测（prec/recall）

对 `docs/视频诈骗扫描.md` 里的 scanner 子代理做质量评测：批量跑（或重放）三维度判定，
对照人工标注算 precision/recall。评分与口径都在 `../scanner_eval.ts`，固定合成对照集在 `fixtures.ts`。

## 三种模式

```bash
# ① 自检：内置合成对照集 + canned 回执，零网络零调用，验证解析与打分管道本身
bun benchmarks/scanner_eval.ts --self-check

# ② 重放（默认）：对已有报告重新打分，改口径/改标注后零成本复算
bun benchmarks/scanner_eval.ts --replay --output work/scanner-eval

# ③ 实跑：对「有快照且有标注」的 BV 逐个真跑 scanner（走真实 delegate 白名单管道）
bun benchmarks/scanner_eval.ts --live --dataset dataset --model qwen3.8-flash [--limit 5] [--only BVxxx] [--force]
```

live 模式的隔离保证（都落在 `--output` 工作目录内，默认 `work/scanner-eval`）：

| 产物 | 位置 | 说明 |
|---|---|---|
| 解析出的报告 | `reports/<BV>.json` | replay 打分的输入；`--force` 重扫覆盖 |
| 原始回执 | `raw/<BV>.txt` | delegate 观察串原文，解析失败时人工排查用 |
| 发现库 | `findings.jsonl` | ingest_findings 的隔离落盘，**不会**写真实 `.agent-data` |
| 子代理轨迹 | `delegates/` | 与主会话轨迹同构，审每个例子的判读过程 |
| 汇总 | `report.json` / `report.md` | 全部用例的打分表 |

打分一律走落盘报告（live 刚写完的也在其中），live 与 replay 共用同一条打分路径。

## 标注格式（labels.json）

```jsonc
{
  "version": 1,
  "cases": [
    {
      "id": "BV1xxxxxxxxxx",          // 同时是快照文件名与报告文件名
      "category": "引流诈骗",          // 分组统计用，自由文本
      "gold": {
        "video": "high",               // high | medium | low | clean | unknown（中文别名也可）
        "author": "medium",
        "comments": "low",
        "overall": "high"
      },
      "notes": "标注依据，可选"
    }
  ]
}
```

标注纪律与 scanner 的判定纪律对齐：标注员判不了的维度填 `unknown`（评测不计入任何分母），
不要为了"有标签"硬猜。

## 口径

- 二元任务：risky = high|medium，safe = low|clean；P/R/F1 只在可判定对（双方都非 unknown）上算。
- 弃权（无法判断/报告缺失/解析失败）是设计的合法行为：单独记弃权率，不当错误。
- 报告缺失的用例整例弃权（四维全 unknown），在逐例表的「报告」列标「缺失」。
- 严格一致 = 4 档完全相等；MAE 按 clean=0/low=1/medium=2/high=3，两者是序数参考，
  主指标是二元 P/R（诈骗检测的操作性口径：漏放一个 medium 比把 clean 判成 low 严重得多）。
- micro 合并 video/author/comments 三维度；overall 是综合结论，单列不并入 micro。

## 固定对照集

`fixtures.ts` 里 6 个合成用例（全对 / 弃权与 gold-unknown / 等级虚高 / 漏报 / 中文标签 / 报告缺失）
的聚合数字全部手工推演过，`tests/scanner_eval.test.ts` 逐项断言——改打分口径前先跑它，
数字变了必须同步改注释并说明理由。

## 已知限制

- live 模式逐个串行跑（每例一次完整子代理会话，inspect_link 真发请求），几十条标注约数小时量级，
  建议 `--limit` 分批；`AGENT_DELEGATE_SCANNER_TIMEOUT_MS` 可放宽单例墙钟。
- rag_search 依赖反诈知识库（`rag:ingest` 的产物），实跑前确保与生产同一份索引，否则对照失真。
- 快照质量直接决定可判维度：`transcript.source=none` 的视频，video 维度对模型只有标题/简介可用。
