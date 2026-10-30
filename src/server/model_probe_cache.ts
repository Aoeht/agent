/** 缓存完成结果并合并并发刷新；失败不缓存，允许下一次重试。 */
export function createProbeCache<C, T>(load: (context: C) => Promise<T>, ttlMs = 60_000, now = Date.now): (context: C) => Promise<T> {
  let cached: { value: T; at: number } | undefined;
  let pending: Promise<T> | undefined;
  return (context) => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = Promise.resolve().then(() => load(context)).then((value) => {
      cached = { value, at: now() };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
