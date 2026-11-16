# 新版证据标注脚本

入口：`bun run benchmarks/annotate_fraud.ts --help`。协议 `fraud-evidence/v2`。

该流程对应“区间初筛模型与数据标定”§3–§5 的修订建议：观察事实、核验宣称、视频/评论风险分别保存。旧标签不覆盖，数据库只读。输出为教师预标与人工复核标签，不自动成为司法定性或全站金标。

## 1. 准备任务（本地，无网络）

```powershell
bun run benchmarks/annotate_fraud.ts prepare --limit 5 --out work/fraud-annotation-pilot
```

默认使用 `video_metadata/merged_20261110/bili_merged_v1.sqlite3` 和 `work/train-segments-30s/segments.jsonl`。

- `--bvid BV...`：指定单个视频。
- `--limit 0`：全部视频；先固定数据划分，再分别准备开发/验证/测试任务。
- `--db FILE`、`--segments FILE`：显式更换数据库/30s 拼图清单。
- `--asset-root DIR`：评论附图相对路径的资源根目录；绝对拼图路径照实读取。
- 已有任务文件不覆盖。输入或规则更新时使用新输出目录。

来源白名单：标题、简介、签名、评论正文与关系、弹幕、已有拼图及其区间 ASR。不读取 `video_labels`、`gold_labels`、审核报告或作者风险评级作为教师输入。

评论采用合并历史并集，保留 parent/root，不删除深层节点；每批20条、约16k正文字符，不截断单条正文。批次不是独立评论树，跨批父链在逐视频证据包中查看。`in_latest_full` 只是来源记录，历史并集不能称为同一时间的当前评论区。要评估特定快照，先按采集快照准备相应数据库。

评论多图按来源关联，图片缺失单独记录，不联网下载。文字单任务超过60k字符时实跑明确失败，不静默裁剪。无拼图、ASR空、分段间隙及采集状态在 `prepare.json` 中可见。现有718视频的分段清单不会自动变成3055视频的完整视觉数据，其他视频需要先生成拼图与ASR。

`has_video` 等旧标记不视为本地资源存在的证明；实际读取图片并校验格式、计算SHA256。任务哈希包含原文、结构、图片哈希、限制及完整提示词。

## 2. 教师预标（默认干跑）

```powershell
bun run benchmarks/annotate_fraud.ts run --out work/fraud-annotation-pilot --model YOUR_VISION_MODEL --limit 2
```

打印实际提示词和一个任务，不发请求。联网执行时由操作者显式配置 `ANNOTATION_API_KEY`，再加 `--base-url https://YOUR_ENDPOINT/v1 --go`。端点须支持 OpenAI Chat Completions 图文输入及 `response_format=json_object`。这里不配置供应商默认价格，不自动切换模型，不把服务端可访问性当真实性核验。

```powershell
bun run benchmarks/annotate_fraud.ts run --out work/fraud-annotation-pilot --model YOUR_VISION_MODEL --base-url https://YOUR_ENDPOINT/v1 --limit 50 --go
```

一个进程顺序运行，避免同时运行多个写入同目录的实例。每条追加保存，可按相同模型、输入和规则哈希续跑；失败不标完成。输出拒绝、截断或不符合契约时最多纠正一次。`usage.jsonl` 记录每次响应usage（含校验失败响应）；`errors.jsonl` 记录失败。坏JSONL/断尾明确报错，人工修复后续跑，不吞掉旧数据。

`labels.jsonl` 永远标记 `teacher_pending_review`。JSON/引用/归因校验能拦截部分错误，不能证明视觉读字、语义归因或外部事实正确。

## 3. 标注员逐条执行的规则

完整教师规则在 `src/bili/annotation.ts` 的 `ANNOTATION_PROMPT`，准备时也复制到 `GUIDE.txt`。

1. 先确认来源：视频自身、主楼、回复、弹幕或第三方截图；不能把普通评论推广归到作者。is_up/置顶属于采集标记，人工仍需核对主体。
2. 记录实际出现的要素和原文。保证性承诺、身份背书、收益截图是形式证据，不能写成“已虚假”。二维码只标图形，不猜解码结果。无法读清用null/low并说明问题。
3. 标记宣传、警示、引用、否定、举报或语境不明。反诈展示保留被引用的要素，但归因第三方；“没有微信”不生成真实联系方式，“不要转账”不生成当前主体的付款要求。
4. 微信、付款、站外入口、价格、课程或行业本身均不能独立决定风险。低价/免费、收益/结果宣称、课程工具服务、通道分别观察；限时不能替代低价，保过不能改写成收入。
5. 身份/交易异常可独立触发复核，无须先命中收益承诺。候选门只是阅读队列，不是最终标签；没触发门也不自动判负。
6. 跨段/评论关联必须确认主体和对象。脚本只提示单任务内共现；人工要检查整份证据包，不能忽略跨任务的真实关联，也不能把无关通道和承诺相乘。
7. 人工核对教师漏标：不仅看已有evidence，还要看原材料；正式评测集须看原视频，不能只看9帧后声称连续时间证据完整。格位只证明采样时刻出现，不能推导出现持续时间。
8. 先区分尚未核验与因访问/资源限制无法核验。没有举报、链接打不开、账号资质未查询到，都不能证明正常或虚假。可访问网页的自述也不是独立真实性证据。
9. 功效/身份/模式矛盾是重要证据路径；异常交易流程可走直接行为路径。不是所有诈骗都必须有“绝对化承诺”。该路径需要人工解释具体机制，不能单凭类型字段自动定性。
10. 视频和评论分别形成结论。未发现只限已检查、材料充分的范围；存在关键缺图、未读任务或未解决宣称时保留不确定性。违法/治理处置规则的适用性另外核实，不将跨平台规则直接当本站定性依据。

## 4. 人工复核与结论

```powershell
bun run benchmarks/annotate_fraud.ts review --out work/fraud-annotation-pilot --model YOUR_VISION_MODEL
```

生成 `reviews/BV....json`（人工填写）和同名 `.evidence.json`（全视频材料、引用索引、待标任务）。已有人工模板不覆盖。

证据引用格式 `任务ID/证据ID`，例如 `BVxxx#comments-1/e2`。复核时可以纠正教师记录；如改动了 `labels.jsonl`，需重新生成证据包，并重新核对/更新人工表的 `input_hash`，旧结论不能自动沿用。保留原版文件作审计，不把覆盖修改当成独立第二人标注。

人工表顶层：bvid、reviewer（真实标注员ID）、reviewed_at（ISO时间）、input_hash（对应证据包）、verifications、decisions。四态核验针对具体claim_ref：

- unverified：尚未完成或证据不足，说明原因。
- verified_true / verified_false：必须填supports，逐项给reference（URL或本地核实记录）、excerpt（支持/反驳原文）、checked_at。核实的是具体宣称，不是整个视频。
- unverifiable：已尝试但受限，写明限制；不可转成负标签。

decisions 必须恰好包含 video 与 comments 两项：

| status | basis | 要求 |
|---|---|---|
| supported | verified_contradiction | 正确归因的宣传宣称被独立证据反驳；说明如何形成风险链 |
| supported | direct_behavior | 引用明确异常交易行为并人工说明机制；普通联系方式不够 |
| suspected | pending_verification | 有实际归因证据，但关键事实待核；列出缺失项 |
| no_risk_observed | none | 已检查全部所供任务、材料充分、无关键缺图/未解决核验；说明判断范围，不等同永久安全 |
| insufficient_evidence | none | 说明缺少哪些材料或任务，保留未知 |

每项还必须填evidence_refs、reason、reviewed_all_supplied、material_sufficient、limitations。supported要求材料足以支持当前结论；不要求整个平台评论全采完。未发现结论要求检查范围充分，不能把抽样未命中说成全评论区正常。

“待填写/待人工复核”的空模板无法通过。语义是否可靠仍由标注员负责，填写非空reason或支持材料不等于事实自动成立。建议先双人独立试标30–50条，处理分歧，再推广；评测标签不能由同一教师预标直接充当金标。

```powershell
bun run benchmarks/annotate_fraud.ts check --out work/fraud-annotation-pilot --model YOUR_VISION_MODEL
```

输出 `adjudicated.jsonl`（通过结构与证据约束的人工结果）及 `check.json`（失败明细）；存在失败退出码为1。该命令不修改原库或旧标签。风险结论与原有处置建议不自动映射。

## 5. 评测注意

门阈值在验证集调，最终测试集冻结；按作者/近重复分组隔离。正常视频也可能有真实营销要素或评论风险。要素抽取与最终风险分别评测；unverifiable既不当正常，也不从总体处理量中消失，应报告占比与可判断覆盖率。

抽教师负例人工检查，得到的是负例内漏标比例；真正FNR需按人工正例总体统计。不要只在被保留段上验收；被丢弃段也需抽查。视频级召回同时检查是否保留到了有效证据，不以任意无关片段存活算成功。

自动化检查：`bun test tests/fraud_annotation.test.ts`。
