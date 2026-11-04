import { normalizeTranscript, type VideoSnapshot } from "./snapshot";

/** 字幕区间覆盖不等于识别准确率；缺视频时长时不能用最后一句冒充全片长度。 */
export function measureDataCoverage(snapshot: VideoSnapshot, durationOverride?: number) {
  const declared = durationOverride ?? snapshot.video?.duration_s;
  const duration = declared !== undefined && Number.isFinite(declared) && declared > 0 ? declared : null;
  const segments = normalizeTranscript(snapshot);
  let invalid = 0;
  let outOfBounds = 0;
  const intervals: Array<{ start_s: number; end_s: number }> = [];
  for (const segment of segments) {
    if (!Number.isFinite(segment.start_s) || !Number.isFinite(segment.end_s)
      || segment.end_s <= segment.start_s || !segment.text.trim()) { invalid += 1; continue; }
    if (segment.start_s < 0 || (duration !== null && segment.end_s > duration)) outOfBounds += 1;
    const start = Math.max(0, segment.start_s);
    const end = Math.min(duration ?? Infinity, segment.end_s);
    if (end > start) intervals.push({ start_s: start, end_s: end });
  }
  intervals.sort((a, b) => a.start_s - b.start_s);
  let covered = 0;
  let cursor = 0;
  let longest = { start_s: 0, end_s: 0, duration_s: 0 };
  for (const interval of intervals) {
    if (interval.start_s - cursor > longest.duration_s) {
      longest = { start_s: cursor, end_s: interval.start_s, duration_s: interval.start_s - cursor };
    }
    covered += Math.max(0, interval.end_s - Math.max(cursor, interval.start_s));
    cursor = Math.max(cursor, interval.end_s);
  }
  if (duration !== null && duration - cursor > longest.duration_s) {
    longest = { start_s: cursor, end_s: duration, duration_s: duration - cursor };
  }
  return {
    duration_s: duration,
    transcript: {
      source: snapshot.transcript?.source ?? "none",
      segment_count: segments.length,
      usable_segment_count: intervals.length,
      invalid_segment_count: invalid,
      out_of_bounds_segment_count: outOfBounds,
      covered_seconds: covered,
      coverage_ratio: duration === null ? null : covered / duration,
      longest_gap: duration === null ? null : longest,
    },
    // 这里只能报告已获得的数据量，不能推断评论/弹幕是否采集完整。
    available: { author: snapshot.author !== undefined, video: snapshot.video !== undefined,
      danmaku_count: snapshot.danmaku.length, comment_count: snapshot.comments.length },
  };
}
