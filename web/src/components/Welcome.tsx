// web/src/components/Welcome.tsx
import { useState } from "react";
import { useStore } from "../state/store";
import { Composer } from "./Composer";
import { SandboxModal } from "./Modals";
import type { SessionConfigInput } from "../lib/transport";
import { firstAvailableModel } from "../lib/modelOptions";

/**
 * 欢迎界面（首页）：左侧会话栏照旧，主区是居中的"新建会话"窗口——
 * 问候语 + 沙箱目录行 + 可直接输入的 Composer。
 * 发出首条消息才真正创建会话（createAndSend）；欢迎态选的模型/参数随首条消息落地，
 * 点"新会话"或首次进入（未选中任何会话）都会停在这里。
 */
export function Welcome() {
  const { state, actions } = useStore();
  const [config, setConfig] = useState<SessionConfigInput>({});
  const [sandboxOpen, setSandboxOpen] = useState(false);

  return (
    <>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-6 pb-24 max-lg:px-4">
        <div className="px-1">
          <h1 className="text-2xl font-semibold tracking-tight">你好，今天要做什么？</h1>
          <p className="mt-2 text-sm text-ink-400">
            本地智能体 · {state.transportKind === "mock" ? "演示数据" : "已连接后端"}
          </p>
        </div>

        <button
          onClick={() => setSandboxOpen(true)}
          title="更改沙箱目录"
          className="group flex items-center gap-2 rounded-xl border border-cream-300 bg-cream-50 px-4 py-2.5 text-left text-xs text-ink-600 transition hover:border-clay-500/50"
        >
          <span className="shrink-0">🗂 沙箱目录</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-400">
            {state.appSettings.sandboxRoot ?? "—"}
          </span>
          <span className="shrink-0 font-medium text-clay-600 transition group-hover:text-clay-500">修改</span>
        </button>

        <Composer
          sessionId={null}
          running={false}
          disabled={false}
          models={state.models}
          modelStatus={state.modelStatus}
          accountQuota={state.modelAccountQuota}
          // 模型回退到第一个探测可用的选项：⚙ 按钮在无 config.model 时会禁用，欢迎态要能直接打开选模型
          config={{ ...config, model: config.model ?? firstAvailableModel(state.models, state.modelStatus) }}
          onSend={(text, images) =>
            void actions.createAndSend(text, Object.keys(config).length > 0 ? config : undefined, images)
          }
          onCancel={() => {}}
          onApplyConfig={async () => {}}
          onDraftConfig={setConfig}
        />
      </div>

      {sandboxOpen && (
        <SandboxModal
          current={state.appSettings.sandboxRoot}
          onClose={() => setSandboxOpen(false)}
          onApply={actions.setSandboxRoot}
        />
      )}
    </>
  );
}
