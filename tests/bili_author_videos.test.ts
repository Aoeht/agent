import { test, expect } from "bun:test";
import { selectAuthorVideos } from "../src/bili/author_videos";
import { AuthorSchema } from "../src/bili/snapshot";

test("先排序去重再取 50 条；同标题保留最新作品并转换时长", () => {
  const works = Array.from({ length: 60 }, (_, i) => ({ title: `标题 ${i}`, created: 1700000000 + i, length: "01:02:03" }));
  works.push({ title: "标题　59", created: 1800000000, length: "02:05" });
  const result = selectAuthorVideos(works.reverse());
  expect(result).toHaveLength(50);
  expect(result[0]).toMatchObject({ title: "标题　59", duration_s: 125, published_at: new Date(1800000000000).toISOString() });
  expect(result[1]?.duration_s).toBe(3723);
  expect(result.at(-1)?.title).toBe("标题 10");
  expect(AuthorSchema.parse({ recent_videos: result }).recent_videos).toEqual(result);
  expect(selectAuthorVideos(result)).toEqual(result);
});

test("缺失/非法长度或日期不编造；空标题忽略；未知日期排末尾", () => {
  const result = selectAuthorVideos([
    { title: "未知日期", length: "unknown", created: "unknown" },
    { title: "空格日期", length: "1:99", created: -1 },
    { title: " ", length: "01:00", created: 1800000001 },
    { title: "有日期", duration_s: 0, published_at: "2026-11-05T08:00:00+08:00" },
    { title: "UNKNOWN date", created: 1e100 }, null,
  ]);
  expect(result[0]).toEqual({ title: "有日期", duration_s: 0, published_at: "2026-11-05T00:00:00.000Z" });
  expect(result[1]).toEqual({ title: "未知日期" });
  expect(result[2]).toEqual({ title: "空格日期" });
  expect(result).toHaveLength(4);
  expect(selectAuthorVideos(undefined)).toEqual([]);
});
