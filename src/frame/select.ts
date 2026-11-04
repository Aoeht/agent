// src/frame/select.ts
/**
 * 候选帧选择：把窗口、视觉状态时间线、场景硬切和作者预算收敛成一组时间点。
 *
 * 优先级：focus（可疑弹幕） > 场景 > 文字带变化 > 状态切换 > 连续变化间隔。
 * 基础覆盖预留少量预算，其余在重点窗口间按 priority 分配；同分帧均匀取样。
 * 普通候选用 dHash 跨窗口去重，文字变化和基础覆盖不被整图哈希否决。
 */
import type { AuthorRiskLevel } from "../bili/author_risk";
import type { FrameBudget } from "./policy";
import type { VideoProfile, VisualSample } from "./profile";
import type { FrameReason, FrameWindow } from "./types";

export interface FrameCandidate {
  t: number;
  /** 1 起的窗口编号 */
  window_index: number;
  reason: FrameReason;
  score: number;
  /** 附近的探针 dHash，用于跨窗口去重 */
  hash?: string;
}

export interface SelectionOptions {
  /** 规划窗口内的覆盖探针间隔（秒），默认 high/medium 30、low/clean 60 */
  probeEveryS?: number;
  /** 判定"画面在变"的整帧变化阈值 */
  stateChangeThreshold?: number;
  /** 判定"文字带在变"的阈值 */
  textChangeThreshold?: number;
  /** 整帧变化超过该值时不再单独补文字帧（已由硬切/状态候选覆盖） */
  textMaxChange?: number;
  /** 连续变化段落的最小取样间隔（秒） */
  continuousStepS?: number;
  /** 同一窗口连续变化的补充帧最多取几张（状态起点另计） */
  continuousMax?: number;
  /** 文字带变化在同一窗口最多取几张 */
  textMax?: number;
  /** 同一视觉段落（相邻硬切之间）最多保留几个 focus 时间点 */
  focusPerSegmentMax?: number;
  /** 跨窗口 dHash 去重的汉明距离上限 */
  hashDistance?: number;
  /** 覆盖窗口的最短空档（秒），短于该值不补覆盖窗口 */
  coverageMinGapS?: number;
  /** 单个覆盖窗口长度（秒） */
  coverageWindowS?: number;
  /** 低于该平均亮度的帧视为黑屏，不取样（0~1） */
  blackLuminance?: number;
}

const DEFAULTS = {
  stateChangeThreshold: 0.03,
  textChangeThreshold: 0.02,
  textMaxChange: 0.1,
  continuousStepS: 5,
  continuousMax: 6,
  textMax: 6,
  focusPerSegmentMax: 3,
  hashDistance: 6,
  coverageMinGapS: 1,
  coverageWindowS: 120,
  blackLuminance: 0.02,
} as const;

const SCORE = {
  focus: 100,
  text: 75,
  state: 70,
  scene: 80,
  continuous: 60,
  probe: 40,
  fallback: 30,
} as const;

const MIN_CANDIDATE_GAP_S = 0.5;

/** 未规划区间也参与基础覆盖；短视频至少按四段的粒度生成候选。 */
export function appendCoverageWindows(
  windows: FrameWindow[],
  durationS: number,
  budget: FrameBudget,
  options: SelectionOptions = {},
): FrameWindow[] {
  if (!(durationS > 0)) return windows;
  // 末尾 0.5s 不补覆盖探针：按末尾时间点抽帧可能落到最后一帧之后
  const usableEnd = durationS - 0.5;
  if (!(usableEnd > 0)) return windows;
  const minGap = options.coverageMinGapS ?? DEFAULTS.coverageMinGapS;
  const step = options.coverageWindowS ?? DEFAULTS.coverageWindowS;
  const coverageStep = Math.max(1, Math.min(budget.coverage_step_s, step, durationS / 4));
  const sorted = windows
    .slice()
    .sort((a, b) => a.start_s - b.start_s);
  const result = [...windows];
  let cursor = 0;
  for (const window of sorted) {
    const start = Math.max(0, Math.min(window.start_s, usableEnd));
    if (start - cursor >= minGap) {
      for (let segStart = cursor; segStart < start; segStart += coverageStep) {
        const segEnd = Math.min(start, segStart + coverageStep);
        if (segEnd - segStart < 1) continue;
        result.push({
          start_s: segStart + 0.5,
          end_s: segEnd,
          reason: "全片覆盖探针：低信号兜底",
          priority: 0.02,
          source: "coverage",
        });
      }
    }
    cursor = Math.max(cursor, Math.min(window.end_s, usableEnd));
  }
  if (usableEnd - cursor >= minGap) {
    for (let segStart = cursor; segStart < usableEnd; segStart += coverageStep) {
      const segEnd = Math.min(usableEnd, segStart + coverageStep);
      if (segEnd - segStart < 1) continue;
      result.push({
        start_s: segStart + 0.5,
        end_s: segEnd,
        reason: "全片覆盖探针：低信号兜底",
        priority: 0.02,
        source: "coverage",
      });
    }
  }
  return result.sort((a, b) => a.start_s - b.start_s);
}

function nearestSample(profile: VideoProfile | undefined, t: number): VisualSample | undefined {
  if (profile === undefined || profile.samples.length === 0 || !(profile.step_s > 0)) return undefined;
  const index = Math.max(0, Math.min(profile.samples.length - 1, Math.round(t / profile.step_s)));
  const candidates = [index - 1, index, index + 1].filter((i) => i >= 0 && i < profile.samples.length);
  let best = candidates[0]!;
  for (const candidate of candidates) {
    if (Math.abs(profile.samples[candidate]!.t - t) < Math.abs(profile.samples[best]!.t - t)) best = candidate;
  }
  return profile.samples[best];
}

function hashAt(profile: VideoProfile | undefined, t: number): string | undefined {
  return nearestSample(profile, t)?.hash;
}

/** 窗口内第一个非黑屏采样点；用于覆盖探针和保底帧 */
function firstVisible(
  profile: VideoProfile | undefined,
  start: number,
  end: number,
  blackLuminance: number,
): number | undefined {
  if (profile === undefined) return undefined;
  return profile.samples.find(
    (sample) => sample.t >= start && sample.t <= end && sample.luminance >= blackLuminance,
  )?.t;
}

/** 一排里均匀抽 max 个（保留首尾，中间等距） */
function evenlyPick<T>(items: T[], max: number): T[] {
  if (max <= 0) return [];
  if (items.length <= max) return items;
  if (max <= 1) return [items[Math.floor((items.length - 1) / 2)]!];
  const picked: T[] = [];
  for (let i = 0; i < max; i += 1) {
    picked.push(items[Math.round((i * (items.length - 1)) / (max - 1))]!);
  }
  return picked;
}

/** 优先保高分；同分候选按时间均匀选择，预截断和最终配额使用同一规则。 */
function pickCandidates(candidates: FrameCandidate[], max: number): FrameCandidate[] {
  const ordered = candidates.slice().sort((a, b) => b.score - a.score || a.t - b.t);
  const picked: FrameCandidate[] = [];
  for (let i = 0; i < ordered.length && picked.length < max;) {
    let end = i + 1;
    while (end < ordered.length && ordered[end]!.score === ordered[i]!.score) end += 1;
    picked.push(...evenlyPick(ordered.slice(i, end), max - picked.length));
    i = end;
  }
  return picked;
}

/** 按硬切把 focus 时间点分段，同一段最多留 max 个；避免一段动画被多个弹幕点重复取样 */
export function capFocusPerSegment(focusTimes: number[], sceneTimes: number[], max: number): number[] {
  const sorted = focusTimes.filter((t) => Number.isFinite(t)).slice().sort((a, b) => a - b);
  if (max <= 0 || sorted.length <= max) return sorted;
  const cuts = sceneTimes.filter((t) => Number.isFinite(t)).slice().sort((a, b) => a - b);
  const groups = new Map<number, number[]>();
  for (const t of sorted) {
    let segment = 0;
    for (const cut of cuts) {
      if (cut < t) segment += 1;
      else break;
    }
    const list = groups.get(segment) ?? [];
    list.push(t);
    groups.set(segment, list);
  }
  return [...groups.values()].flatMap((group) => evenlyPick(group, max)).sort((a, b) => a - b);
}

function windowCandidates(
  window: FrameWindow,
  windowIndex: number,
  profile: VideoProfile | undefined,
  sceneTimes: number[],
  probeEveryS: number,
  options: SelectionOptions,
): FrameCandidate[] {
  const start = window.start_s;
  const end = window.end_s;
  if (!(end > start)) return [];
  const clampT = (t: number) => Math.max(start, Math.min(end - 0.05, t));
  const blackLuminance = options.blackLuminance ?? DEFAULTS.blackLuminance;
  const isBlack = (t: number): boolean => {
    const sample = nearestSample(profile, t);
    return sample !== undefined && sample.luminance < blackLuminance;
  };
  const candidates: FrameCandidate[] = [];
  const add = (t: number, reason: FrameReason, score: number) => {
    if (!Number.isFinite(t) || t < start || t > end) return;
    const clamped = clampT(t);
    // 黑屏/纯黑过场没有视觉证据，别占九宫格格位
    if (isBlack(clamped)) return;
    // 基础覆盖不能被其他时间段的整图哈希删除，否则预留配额失去意义。
    const hash = profile === undefined || window.source === "coverage" ? undefined : hashAt(profile, clamped);
    candidates.push({
      t: clamped,
      window_index: windowIndex,
      reason,
      score: score + (window.priority ?? 0.5) * 10,
      ...(hash === undefined ? {} : { hash }),
    });
  };

  const focusMax = options.focusPerSegmentMax ?? DEFAULTS.focusPerSegmentMax;
  for (const t of capFocusPerSegment(window.focus_times ?? [], sceneTimes, focusMax)) {
    add(t, "focus", SCORE.focus);
  }
  for (const t of sceneTimes) add(t, "scene", SCORE.scene);

  const isCoverage = window.source === "coverage";
  if (!isCoverage) {
    for (let t = start + 1; t < end - 0.05; t += probeEveryS) add(t, "interval", SCORE.probe);
    add(Math.max(start, end - 0.5), "interval", SCORE.probe);

    if (profile !== undefined && profile.samples.length > 0) {
      const stateThreshold = options.stateChangeThreshold ?? DEFAULTS.stateChangeThreshold;
      const textThreshold = options.textChangeThreshold ?? DEFAULTS.textChangeThreshold;
      const textMaxChange = options.textMaxChange ?? DEFAULTS.textMaxChange;
      const continuousStep = options.continuousStepS ?? DEFAULTS.continuousStepS;
      const continuousMax = options.continuousMax ?? DEFAULTS.continuousMax;
      const textMax = options.textMax ?? DEFAULTS.textMax;
      let active = false;
      const continuousTimes: number[] = [];
      let lastContinuous = Number.NEGATIVE_INFINITY;
      const textTimes: number[] = [];
      let lastText = Number.NEGATIVE_INFINITY;
      for (const sample of profile.samples) {
        if (sample.t < start || sample.t > end) continue;
        const moving = sample.change >= stateThreshold;
        const textMoving = sample.text_change >= textThreshold;
        if (moving && !active) {
          add(sample.t, "state", SCORE.state);
          active = true;
          lastContinuous = sample.t;
        } else if (moving && active && sample.t - lastContinuous >= continuousStep) {
          if (!isBlack(sample.t)) continuousTimes.push(sample.t);
          lastContinuous = sample.t;
        } else if (!moving) {
          active = false;
        }
        // 整帧都在动（片头动画/快剪）时，硬切与状态候选已覆盖这一时刻；
        // 再按文字带补帧只会重复同一画面，文字帧只服务于"画面基本静止、字幕在变"。
        if (textMoving && sample.change < textMaxChange && sample.t - lastText >= 2 && !isBlack(sample.t)) {
          textTimes.push(sample.t);
          lastText = sample.t;
        }
      }
      for (const t of evenlyPick(continuousTimes, continuousMax)) add(t, "state", SCORE.continuous);
      for (const t of evenlyPick(textTimes, textMax)) add(t, "text", SCORE.text);
    }
  } else {
    // 每段选变化最明显的可见点；同分靠近中点，无画像时直接取中点。
    const midpoint = (start + end) / 2;
    const representative = profile?.samples
      .filter((sample) => sample.t >= start && sample.t < end && sample.luminance >= blackLuminance)
      .sort((a, b) => (b.change + b.text_change) - (a.change + a.text_change)
        || Math.abs(a.t - midpoint) - Math.abs(b.t - midpoint))[0];
    add(representative?.t ?? midpoint, "interval", SCORE.probe);
  }

  if (candidates.length === 0) {
    add(firstVisible(profile, start, end, blackLuminance) ?? start + 0.5, "interval", SCORE.fallback);
  }
  return candidates;
}

/** 时间邻域去重：保留分数更高的候选，0.5s 内只留一个 */
export function dedupeByTime(candidates: FrameCandidate[]): FrameCandidate[] {
  const ordered = candidates
    .slice()
    .sort((a, b) => b.score - a.score || a.t - b.t);
  const kept: FrameCandidate[] = [];
  for (const candidate of ordered) {
    if (kept.some((existing) => Math.abs(existing.t - candidate.t) < MIN_CANDIDATE_GAP_S)) continue;
    kept.push(candidate);
  }
  return kept.sort((a, b) => a.t - b.t);
}

/** 文字变化与 focus 不由整图哈希否决；硬切只去近乎相同的帧。 */
export function dedupeByHash(
  candidates: FrameCandidate[],
  threshold: number = DEFAULTS.hashDistance,
): FrameCandidate[] {
  const ordered = candidates
    .slice()
    .sort((a, b) => b.score - a.score || a.t - b.t);
  const kept: FrameCandidate[] = [];
  const keptHashes: Array<{ hash: string; bits: bigint; strict: boolean }> = [];
  for (const candidate of ordered) {
    if (candidate.reason === "focus" || candidate.reason === "text" || candidate.hash === undefined) {
      kept.push(candidate);
      continue;
    }
    const bits = BigInt(`0x${candidate.hash}`);
    const strict = candidate.reason === "scene";
    const duplicate = keptHashes.some((existing) => {
      const limit = strict || existing.strict ? 2 : threshold;
      return hammingBits(bits, existing.bits) <= limit;
    });
    if (duplicate) continue;
    kept.push(candidate);
    keptHashes.push({ hash: candidate.hash, bits, strict });
  }
  return kept.sort((a, b) => a.t - b.t);
}

function hammingBits(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/** 窗口间按 priority 分配帧配额；先保证每窗 1 张，再按权重分剩余 */
export function allocateQuotas(
  windows: FrameWindow[],
  capacities: number[],
  maxFrames: number,
): number[] {
  const quotas = new Array<number>(windows.length).fill(0);
  if (windows.length === 0 || maxFrames <= 0) return quotas;
  const order = windows
    .map((window, index) => ({ index, priority: window.priority ?? 0.5, capacity: capacities[index] ?? 0 }))
    .filter((item) => item.capacity > 0)
    .sort((a, b) => b.priority - a.priority || a.index - b.index);
  let remaining = maxFrames;
  for (const item of order) {
    if (remaining <= 0) break;
    quotas[item.index] = 1;
    remaining -= 1;
  }
  const weightSum = order.reduce((sum, item) => sum + item.priority + 0.1, 0);
  if (weightSum > 0) {
    // 先算可分配量再按权重切分；不能一边扣 remaining 一边算占比，否则后面的窗口永远吃不饱
    const room = order.reduce((sum, item) => sum + Math.max(0, item.capacity - quotas[item.index]!), 0);
    const shareable = Math.min(remaining, room);
    let allocated = 0;
    for (const item of order) {
      const extraRoom = item.capacity - quotas[item.index]!;
      if (extraRoom <= 0) continue;
      const share = Math.floor(shareable * ((item.priority + 0.1) / weightSum));
      const add = Math.min(extraRoom, Math.max(0, share));
      quotas[item.index] = quotas[item.index]! + add;
      allocated += add;
    }
    // 取整余数按优先级补满，直到预算用完或所有窗口达到容量
    let leftover = shareable - allocated;
    while (leftover > 0) {
      let progressed = false;
      for (const item of order) {
        if (leftover <= 0) break;
        if (quotas[item.index]! >= item.capacity) continue;
        quotas[item.index] = quotas[item.index]! + 1;
        leftover -= 1;
        progressed = true;
      }
      if (!progressed) break;
    }
  }
  return quotas;
}

export interface SelectFramesParams {
  windows: FrameWindow[];
  budget: FrameBudget;
  profile?: VideoProfile;
  /** 窗口序号（1 起）→ 场景切换时间点 */
  sceneTimes?: Map<number, number[]>;
  options?: SelectionOptions;
}

export interface SelectionResult {
  /** 选中并已按窗口、时间排序的候选 */
  selected: FrameCandidate[];
  /** 去重后的候选总数，用于判断预算是否截断 */
  candidate_count: number;
}

/** 主入口：生成候选、去重、按预算选帧；返回值已按时间排序 */
export function selectFrameCandidates(params: SelectFramesParams): SelectionResult {
  const { windows, budget, profile } = params;
  const options = params.options ?? {};
  const probeEveryS = options.probeEveryS ??
    (budget.level === "high" || budget.level === "medium" ? 30 : 60);

  const perWindow = windows.map((window, index) => {
    const raw = windowCandidates(
      window,
      index + 1,
      profile,
      params.sceneTimes?.get(index + 1) ?? [],
      probeEveryS,
      options,
    );
    const deduped = dedupeByTime(raw);
    // 先保留两倍单窗上限，给跨窗口去重和配额分配留余量，避免候选爆炸
    return pickCandidates(deduped, Math.max(1, budget.per_window_max * 2))
      .sort((a, b) => a.t - b.t);
  });

  const flat = dedupeByHash(perWindow.flat(), options.hashDistance);
  const byWindow = new Map<number, FrameCandidate[]>();
  for (const candidate of flat) {
    const list = byWindow.get(candidate.window_index) ?? [];
    list.push(candidate);
    byWindow.set(candidate.window_index, list);
  }
  const capacities = windows.map((_, index) =>
    Math.min(budget.per_window_max, byWindow.get(index + 1)?.length ?? 0));
  // 命中可疑弹幕的窗口优先于普通窗口：预算只够一张时先看可疑点
  const priorityWindows = windows.map((window) =>
    (window.focus_times?.length ?? 0) > 0
      ? { ...window, priority: Math.max(window.priority ?? 0.5, 0.8) }
      : window);
  // 覆盖预留 20%，有重点窗口且只够一帧时仍优先重点；重点用不完的额度归还覆盖。
  const coverageIndexes = windows.flatMap((window, index) =>
    window.source === "coverage" && capacities[index]! > 0 ? [index] : []);
  const planCapacities = capacities.map((capacity, index) => windows[index]!.source === "coverage" ? 0 : capacity);
  const planCapacity = planCapacities.reduce((sum, capacity) => sum + capacity, 0);
  const reserved = Math.min(coverageIndexes.length, budget.max_frames, Math.max(
    budget.max_frames - planCapacity,
    Math.min(Math.ceil(budget.max_frames * 0.2), Math.max(0, budget.max_frames - 1)),
  ));
  const quotas = allocateQuotas(priorityWindows, planCapacities, budget.max_frames - reserved);
  for (const index of evenlyPick(coverageIndexes, reserved)) quotas[index] = 1;

  const selected: FrameCandidate[] = [];
  for (let index = 0; index < windows.length; index += 1) {
    const quota = quotas[index] ?? 0;
    if (quota <= 0) continue;
    const list = byWindow.get(index + 1) ?? [];
    const chosen = pickCandidates(list, quota);
    selected.push(...chosen);
  }
  return {
    selected: selected.sort((a, b) => a.window_index - b.window_index || a.t - b.t),
    candidate_count: flat.length,
  };
}

/** 供 CLI 打印：各档预算的可读说明 */
export function describeBudget(level: AuthorRiskLevel, budget: FrameBudget): string {
  return `${level}: 最多 ${budget.max_grids} 张九宫格（${budget.max_frames} 帧），单窗 ${budget.per_window_max} 帧，覆盖间隔 ${budget.coverage_step_s}s`;
}
