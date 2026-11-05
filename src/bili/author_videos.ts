import { z } from "zod";

export const AuthorVideoSchema = z.object({
  title: z.string().trim().min(1),
  bvid: z.string().optional(),
  duration_s: z.number().finite().nonnegative().optional(),
  published_at: z.string().datetime({ offset: true }).optional(),
});
export type AuthorVideo = z.infer<typeof AuthorVideoSchema>;

function duration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string" || !/^\d+:\d{2}(?::\d{2})?$/.test(value.trim())) return undefined;
  const parts = value.trim().split(":").map(Number);
  if (parts.slice(1).some(n => n >= 60)) return undefined;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** 兼容采集 works 的 created(Unix 秒)/length(mm:ss 或 hh:mm:ss) 与标准字段。
 * 先排序再按规范化标题去重，保留同标题最新一期；时间未知放末尾，不猜测日期。
 */
export function selectAuthorVideos(works: unknown): AuthorVideo[] {
  if (!Array.isArray(works)) return [];
  const videos: AuthorVideo[] = [];
  for (const row of works) {
    if (!row || typeof row !== "object" || typeof row.title !== "string" || !row.title.trim()) continue;
    const rawTime = row.published_at ?? row.created;
    const time = typeof rawTime === "number" && rawTime > 0 ? rawTime * 1000
      : typeof rawTime === "string" && z.string().datetime({ offset: true }).safeParse(rawTime).success ? Date.parse(rawTime) : NaN;
    const published = Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? new Date(time).toISOString() : undefined;
    const seconds = duration(row.duration_s ?? row.length);
    videos.push({ title: row.title.trim(),
      ...(typeof row.bvid === "string" && /^BV[0-9A-Za-z]{10}$/.test(row.bvid) ? { bvid: row.bvid } : {}),
      ...(seconds === undefined ? {} : { duration_s: seconds }),
      ...(published === undefined ? {} : { published_at: published }),
    });
  }
  videos.sort((a, b) => (b.published_at ? Date.parse(b.published_at) : -Infinity) - (a.published_at ? Date.parse(a.published_at) : -Infinity));
  const seen = new Set<string>();
  return videos.filter(v => {
    const key = v.title.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 50);
}
