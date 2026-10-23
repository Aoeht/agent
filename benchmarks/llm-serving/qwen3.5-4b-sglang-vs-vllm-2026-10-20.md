# Qwen3.5-4B 推理性能对比：SGLang vs vLLM

> 测试日期：2026-10-20　｜　机器：`ly534-Precision-3660`（192.168.3.159）　｜　执行人：DSH agent

---

## 1. 结论速览

| 场景 | 推荐 | 依据 |
|---|---|---|
| **交互式对话 / 低并发** | **SGLang** | TTFT 快 2.2–5.6 倍，启动快 3.6 倍，上下文拉到 8K 也不掉速 |
| **高并发批量吞吐** | vLLM，但**必须** `--max-model-len 4096` | 4K 下聚合吞吐 184.9 tok/s，略胜 SGLang 的 159.8 |
| **这台机器日常使用** | **SGLang** | 单卡 24GB，稳定性优先；vLLM 在 8K 上下文会踩 mamba cache 的坑，速度掉 4 倍 |

**一句话**：4K 上下文下两者单流性能基本持平（27.5 vs 25.5 tok/s），但 vLLM 在 8K 上下文会**断崖式掉到 6.7 tok/s**，而 SGLang 全程稳定在 27–29 tok/s。

---

## 2. 测试环境

| 项目 | 值 |
|---|---|
| CPU / 内存 | 24 核 / 62 GB |
| GPU | NVIDIA RTX A5000 24 GB（Ampere，sm_86，单卡） |
| 驱动 | 595.99.02（CUDA 13.2） |
| 系统 | Ubuntu 22.04.3，内核 6.2.0-37 |
| SGLang | 0.5.16，torch 2.11.0+cu130，后端 `flashinfer` |
| vLLM | 0.18.1，torch 2.10.0+cu128，后端 `FLASH_ATTN` + torch.compile + full CUDA Graph |
| 模型 | Qwen3.5-4B（bf16，`Qwen3_5ForConditionalGeneration`，混合线性注意力） |
| 显存比例 | 两边均 0.55（SGLang `--mem-fraction-static`，vLLM `--gpu-memory-utilization`） |

---

## 3. 测试方法

- 请求：prompt **322 tokens** → 输出 **256 tokens**，`temperature=0`、`ignore_eos=true`
- 流式（SSE）采集，因此 TTFT 为真实首 token 延迟
- 单流：串行 5 次取均值；并发：8 并发共 24 次请求
- 每档先发一次 warmup 请求再计时
- 失败请求均为 0
- 脚本：`bench_llm.py`（同目录），指标定义：
  - `per_req_tok_s` = 单请求 completion_tokens / (e2e − 0) ，即端到端输出速度
  - `agg_tok_s` = 全部输出 token 数 / 墙钟时间

---

## 4. 结果一：8K 上下文（各自默认配置）

| 指标 | SGLang | vLLM | 差异 |
|---|---:|---:|---|
| 启动到就绪 | **34 s** | 123 s | SGLang 快 3.6× |
| TTFT p50（单流） | **73.6 ms** | 415.4 ms | SGLang 快 5.6× |
| TTFT avg（单流） | 161.9 ms | 2801.8 ms | SGLang 快 17× |
| 单流输出速度 | **28.57 tok/s** | 6.70 tok/s | **SGLang 快 4.3×** |
| 并发8 单请求 | **24.97 tok/s** | 6.01 tok/s | SGLang 快 4.2× |
| 并发8 聚合吞吐 | **171.15 tok/s** | 48.09 tok/s | **SGLang 快 3.6×** |
| 并发8 墙钟（24 请求） | 35.9 s | 127.8 s | — |

---

## 5. 结果二：4K 上下文（公平对齐）

| 指标 | SGLang | vLLM | 差异 |
|---|---:|---:|---|
| TTFT p50（单流） | **77.7 ms** | 174.8 ms | SGLang 快 2.2× |
| 单流输出速度 | **27.53 tok/s** | 25.53 tok/s（p50 27.04） | SGLang 略快 8% |
| 并发8 单请求 | 23.33 tok/s | 23.12 tok/s | 持平 |
| **并发8 聚合吞吐** | 159.81 tok/s | **184.87 tok/s** | **vLLM 高 16%** |
| 并发8 墙钟（24 请求） | 38.45 s | 33.23 s | — |

---

## 6. 关键发现：vLLM 的 6.7 tok/s 是配置问题，不是框架问题

vLLM 在 8K 上下文时日志出现：

```
WARNING [compilation.py:1236] Capping cudagraph capture sizes from max 512 to 104
        to fit Mamba cache blocks (106 blocks available).
```

**机理**：Qwen3.5 是混合线性注意力（GDN/Mamba）模型，mamba state cache 随 `max-model-len` 线性增长。8K 上下文下可用缓存块只剩 106 个，CUDA Graph 捕获尺寸被从 512 砍到 104，decode 掉进 piecewise/慢路径，速度从 ~25 tok/s 跌到 6.7 tok/s。

改成 `--max-model-len 4096` 后立刻恢复（6.7 → 24.4–25.5 tok/s，**约 4 倍**）。

SGLang 在同一模型上没有此问题：8K 与 4K 分别为 28.57 / 27.53 tok/s，只差 4%。

**vLLM 参数建议**（这台机器）：

```bash
--max-model-len 4096          # 关键！8K 会掉速 4 倍
--gpu-memory-utilization 0.55
--dtype bfloat16
--trust-remote-code
```

若确实需要 8K 上下文，可尝试提高 `--gpu-memory-utilization`（到 0.85 左右）以换取更多 mamba cache 块，但会压缩 KV cache 空间，需要实测。

---

## 7. 性能天花板参考

4B bf16 权重约 8 GB，A5000 显存带宽 768 GB/s，理论 decode 上限约 **90 tok/s**。实测两边单流都在 ~30%，主要开销来自 Qwen3.5 混合注意力层的前向结构本身（每 token 需过 GDN 状态更新）。想进一步提升只能走量化（AWQ/INT4）。

---

## 8. 复现命令

```bash
# 1) 起 SGLang
python -m sglang.launch_server --model-path <Qwen3.5-4B> \
  --served-model-name qwen --port 30000 \
  --attention-backend flashinfer --mem-fraction-static 0.55 --context-length 4096

# 2) 起 vLLM
python -m vllm.entrypoints.openai.api_server --model <Qwen3.5-4B> \
  --served-model-name qwen --port 30001 \
  --max-model-len 4096 --gpu-memory-utilization 0.55 --dtype bfloat16 --trust-remote-code

# 3) 跑基准（单流 5 次 + 并发 8 共 24 次）
python3 bench_llm.py http://127.0.0.1:30000 qwen 5 24
```

---

## 9. 注意事项 / 数据可信度

- 每个配置仅跑一轮，单流 n=5、并发 n=24；预期波动 ±5%。
- TTFT 的 avg 会被首个冷请求显著拉高（vLLM 单流 avg 2801 ms vs p50 415 ms 就是这个原因），比较时建议看 p50。
- 两边的显存比例语义不同（SGLang 是"静态显存占比"，vLLM 是"总显存上限"），0.55 只是取一个都能跑满的近似值，未做各自最优调优。
- vLLM 首次启动含 torch.compile（约 38 s），这部分计入启动时间但不影响推理指标；二次启动会命中编译缓存。
- 测试时 GPU 无其他负载（空闲显存占用 37 MiB）。

---

## 10. 附：本次排查中顺带修复的环境问题

测试前该环境的 SGLang 完全无法启动，根因链（已全部修复）：

1. 驱动 565.57.01（CUDA 12.7）→ 升级 **595.99.02（CUDA 13.2）**
2. torch `2.11.0+cu128` 与 sglang 0.5.16 要求的 cu13 全家桶不匹配 → 换成 **`+cu130`**
3. `sgl-deep-gemm` 缺 `libcudart.so.13` → 随 torch cu130 一并解决
4. 系统 `nvcc` 11.5 不支持 `-std=c++20` → 安装 **CUDA Toolkit 13.1**
5. `/usr/bin/gcc` 是 gcc 9.5（无 cc1plus）→ 建 `~/bin/gcc → gcc-11` 软链
6. `/etc/bash.bashrc` 重复追加 CUDA 路径、`CUDA_HOME` 被写成冒号列表 → 改为幂等写法
7. `.bashrc` 非交互早退导致脚本环境缺失 → 抽出 `~/.toolchain.sh`，由 `.bashrc` 与 `.profile` 共用

启动脚本：`~/start_sglang.sh`（服务器上）。
