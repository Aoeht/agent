// src/bili/srt.ts
/**
 * SRT 字幕解析：text_stamp/ 里的 B 站字幕就是这个格式（带 "[说话人 N]:" 说话人前缀）。
 * 纯函数，采集侧（快照生成）与本仓库的快照归一化共用。
 */

export interface SubSegment {
  start_s: number;
  end_s: number;
  text: string;
}

const TIMECODE_RE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** 说话人前缀（如 "[说话人 0]:"），转写工具产物，对风险判定没有信息量 */
const SPEAKER_PREFIX_RE = /^\s*\[说话人\s*\d+\]\s*[:：]\s*/;

export function parseSrt(content: string): SubSegment[] {
  const text = content.replace(/^\uFEFF/, "");
  const segments: SubSegment[] = [];
  for (const block of text.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    // 兼容缺索引行的写法：时间码行在块内任何位置都认
    const timeIndex = lines.findIndex((line) => TIMECODE_RE.test(line));
    if (timeIndex === -1) continue;
    const match = TIMECODE_RE.exec(lines[timeIndex]!)!;
    const start_s = timecodeToSeconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const end_s = timecodeToSeconds(match[5]!, match[6]!, match[7]!, match[8]!);
    const body = lines.slice(timeIndex + 1)
      .map((line) => line.replace(SPEAKER_PREFIX_RE, ""))
      .join(" ")
      .trim();
    if (!body) continue;
    segments.push({ start_s, end_s, text: body });
  }
  return segments;
}

function timecodeToSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}
