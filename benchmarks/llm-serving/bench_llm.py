"""OpenAI-compatible streaming benchmark: TTFT / per-request tok/s / aggregate tok/s.

Usage: python bench_llm.py <base_url> <model> <n_single> <n_concurrent>
Example: python bench_llm.py http://127.0.0.1:30000 qwen 5 24
"""
import json, sys, time, threading, statistics
import requests

BASE = sys.argv[1]; MODEL = sys.argv[2]
N1 = int(sys.argv[3]); NC = int(sys.argv[4])
MAXTOK = 256

PROMPT = "请解释一下大语言模型推理中的 KV Cache 机制，以及它为什么能显著降低显存占用和计算量。" * 12


def one(i, sink):
    t0 = time.perf_counter()
    try:
        r = requests.post(f"{BASE}/v1/chat/completions", json={
            "model": MODEL,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": MAXTOK, "temperature": 0.0, "ignore_eos": True,
            "stream": True, "stream_options": {"include_usage": True},
        }, stream=True, timeout=600)
        ttft = None; ntok = 0; usage = None
        for line in r.iter_lines():
            if not line:
                continue
            line = line.decode("utf-8", "ignore")
            if not line.startswith("data: "):
                continue
            d = line[6:]
            if d == "[DONE]":
                break
            try:
                j = json.loads(d)
            except Exception:
                continue
            if j.get("usage"):
                usage = j["usage"]
            ch = j.get("choices") or []
            if ch and ch[0].get("delta", {}).get("content"):
                if ttft is None:
                    ttft = time.perf_counter() - t0
                ntok += 1
        e2e = time.perf_counter() - t0
        if usage and usage.get("completion_tokens"):
            ntok = usage["completion_tokens"]
        sink[i] = {"ttft": ttft, "e2e": e2e, "tokens": ntok,
                   "ptok": (usage or {}).get("prompt_tokens")}
    except Exception as e:
        sink[i] = {"err": repr(e)[:200]}


def run(n, concurrency):
    sink = {}
    t0 = time.perf_counter()
    if concurrency == 1:
        for i in range(n):
            one(i, sink)
    else:
        lock = threading.Lock(); idx = [0]

        def worker():
            while True:
                with lock:
                    if idx[0] >= n:
                        return
                    i = idx[0]; idx[0] += 1
                one(i, sink)

        ts = [threading.Thread(target=worker) for _ in range(concurrency)]
        [t.start() for t in ts]; [t.join() for t in ts]
    wall = time.perf_counter() - t0
    ok = [v for v in sink.values() if "err" not in v]
    errs = [v for v in sink.values() if "err" in v]
    if not ok:
        return {"error": errs[:2]}
    ttfts = [v["ttft"] for v in ok if v["ttft"]]
    tps = [v["tokens"] / v["e2e"] for v in ok if v["e2e"] > 0]
    total_tok = sum(v["tokens"] for v in ok)
    return {
        "concurrency": concurrency, "requests": len(ok), "failed": len(errs),
        "wall_s": round(wall, 2),
        "ttft_ms_avg": round(statistics.mean(ttfts) * 1000, 1) if ttfts else None,
        "ttft_ms_p50": round(statistics.median(ttfts) * 1000, 1) if ttfts else None,
        "per_req_tok_s_avg": round(statistics.mean(tps), 2) if tps else None,
        "per_req_tok_s_p50": round(statistics.median(tps), 2) if tps else None,
        "agg_tok_s": round(total_tok / wall, 2),
        "prompt_tokens": ok[0].get("ptok"),
        "out_tokens": ok[0]["tokens"],
    }


print(json.dumps({"single": run(N1, 1), "concurrent": run(NC, 8)}, ensure_ascii=False))
