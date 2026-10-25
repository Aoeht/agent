// web/src/lib/modelOptions.ts
// 模型下拉列表的可用性过滤：探测失败（配额耗尽/不可用/异常）的模型直接从列表剔除；
// 未探测到的模型（服务商全量清单里的大部分）不知道状态，保留。
import type { ModelProbeStatus } from "@protocol";

export function statusByModel(status: ModelProbeStatus[] | undefined): Map<string, ModelProbeStatus> {
  return new Map((status ?? []).map((probe) => [probe.model, probe]));
}

/** 当前生效模型是探测失败的死模型时保留在列表尾（带 ⛔ 标注），否则 select 会空白显示 */
export function visibleModelOptions(
  models: string[],
  status: ModelProbeStatus[] | undefined,
  activeModel?: string
): string[] {
  const probes = statusByModel(status);
  const visible = models.filter((model) => {
    const probe = probes.get(model);
    return probe === undefined || probe.ok;
  });
  if (activeModel !== undefined && activeModel !== "" && !visible.includes(activeModel) && models.includes(activeModel)) {
    visible.push(activeModel);
  }
  return visible;
}

/** 默认选中项：列表里第一个探测可用（或未知状态）的模型 */
export function firstAvailableModel(models: string[], status: ModelProbeStatus[] | undefined): string | undefined {
  const probes = statusByModel(status);
  return models.find((model) => {
    const probe = probes.get(model);
    return probe === undefined || probe.ok;
  });
}
