// src/mcp/policy_matrix.ts
import { ToolAnnotationsLite, ToolPolicy, ToolPolicyAction, ToolPolicyRequest } from "./types";

/** 由 annotations 推导出的风险级别，从低到高。 */
export type RiskLevel = "minimal" | "low" | "moderate" | "high" | "critical";

const RISK_ORDER: RiskLevel[] = ["minimal", "low", "moderate", "high", "critical"];

function rank(level: RiskLevel): number {
  return RISK_ORDER.indexOf(level);
}

/**
 * 能力矩阵：把「是否只读 / 是否破坏性 / 是否触达外部世界 / 是否幂等」映射成一个风险级别。
 * 只读永远比可写安全；触达外部世界的副作用不可回收，故升一级；
 * 破坏性再升一级；幂等说明可安全重试，降一级。
 */
export function riskOf(annotations?: ToolAnnotationsLite): RiskLevel {
  const readOnly = annotations?.readOnlyHint === true;
  if (readOnly) {
    return annotations?.openWorldHint === true ? "low" : "minimal";
  }

  const destructive = annotations?.destructiveHint !== false; // 缺省按最保守：可能破坏
  const openWorld = annotations?.openWorldHint !== false;

  let level: RiskLevel;
  if (destructive && openWorld) level = "critical";
  else if (destructive) level = "high";
  else if (openWorld) level = "high";
  else level = "moderate"; // 本地可写、非破坏：交给路径守卫兜底

  if (annotations?.idempotentHint === true && rank(level) > rank("moderate")) {
    level = RISK_ORDER[rank(level) - 1]!;
  }
  return level;
}

export interface PolicyMatrixOptions {
  /** 风险级别 ≤ 此值直接放行，默认 "moderate"（本地非破坏写入也放行，靠路径守卫兜底） */
  allowUpTo?: RiskLevel;
  /** 风险级别 ≥ 此值直接拒绝，默认 "critical"（外部破坏性） */
  denyAtOrAbove?: RiskLevel;
  /** Server 未声明 annotations 时的动作，默认 "ask"（不给未知工具放行也不直接拒） */
  undeclaredAction?: ToolPolicyAction;
  /** 按注册名精确覆盖矩阵结果 */
  toolOverrides?: Record<string, ToolPolicyAction>;
  /** 按 serverId 覆盖整台 Server（注册名覆盖优先于 Server 覆盖） */
  serverOverrides?: Record<string, ToolPolicyAction>;
}

/**
 * 生成一个数据驱动的策略矩阵 ToolPolicy。默认矩阵：
 *   minimal/low/moderate → allow，high → ask，critical → deny；
 *   未声明 annotations → ask；可用 overrides 精确收紧或放宽。
 */
export function createPolicyMatrix(options: PolicyMatrixOptions = {}): ToolPolicy {
  const allowMaxRank = rank(options.allowUpTo ?? "moderate");
  const denyMinRank = rank(options.denyAtOrAbove ?? "critical");
  const undeclared = options.undeclaredAction ?? "ask";

  return (req: ToolPolicyRequest): ToolPolicyAction => {
    const byName = options.toolOverrides?.[req.registeredName];
    if (byName) return byName;
    const byServer = options.serverOverrides?.[req.serverId];
    if (byServer) return byServer;

    // Server 没声明 annotations：默认值不代表它安全，走保守的固定动作。
    if (req.declared === false) return undeclared;

    const level = riskOf(req.annotations);
    if (rank(level) <= allowMaxRank) return "allow";
    if (rank(level) >= denyMinRank) return "deny";
    return "ask";
  };
}
