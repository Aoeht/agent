// web/src/lib/modelOptions.ts
// 模型下拉列表的可用性过滤：探测确凿不可用（配额耗尽/模型不存在）的模型从列表剔除；
// error（429/网络抖动）是不确定结果保留标注。类型走相对路径（本文件也被根 tsconfig 编译）
import type { ModelProbeStatus } from "../../../src/server/protocol";

export function statusByModel(status: ModelProbeStatus[] | undefined): Map<string, ModelProbeStatus> {
  return new Map((status ?? []).map((probe) => [probe.model, probe]));
}

/** 下拉列表：剔除探测确凿不可用的（配额耗尽/模型不存在）；error 是不确定结果
 * （429 限流、网络抖动——多半是我们自己全量探测打出来的），保留只标 ⚠️。
 * 当前生效模型是探测失败的死模型时保留在列表尾（带 ⛔ 标注），否则 select 会空白显示 */
export function visibleModelOptions(
  models: string[],
  status: ModelProbeStatus[] | undefined,
  activeModel?: string
): string[] {
  const probes = statusByModel(status);
  const visible = models.filter((model) => {
    const probe = probes.get(model);
    return probe === undefined || probe.ok || probe.kind === "error";
  });
  if (activeModel !== undefined && activeModel !== "" && !visible.includes(activeModel) && models.includes(activeModel)) {
    visible.push(activeModel);
  }
  return visible;
}

/** 默认选中项：列表里第一个探测可用（或未知/不确定状态）的模型 */
export function firstAvailableModel(models: string[], status: ModelProbeStatus[] | undefined): string | undefined {
  const probes = statusByModel(status);
  return models.find((model) => {
    const probe = probes.get(model);
    return probe === undefined || probe.ok || probe.kind === "error";
  });
}
