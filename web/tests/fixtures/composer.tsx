import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer, type ComposerConfig } from "../../src/components/Composer";
import type { SessionConfigInput } from "../../src/lib/transport";

function Fixture() {
  const [sessionId, setSessionId] = useState("a");
  const [config, setConfig] = useState<ComposerConfig>({ model: "old", temperature: 0.1, maxIterations: 8, contextWindow: 128_000 });
  const fixture = (window as any).fixture ??= { submissions: [], fail: false };
  fixture.update = setConfig;
  fixture.switchSession = setSessionId;
  return <Composer sessionId={sessionId} running={false} disabled={false}
    models={["old", "chosen", "late"]} config={config} onSend={() => {}} onCancel={() => {}}
    onApplyConfig={async (patch: SessionConfigInput) => {
      fixture.submissions.push({ sessionId, ...patch });
      if (fixture.fail) throw new Error("保存失败，请重试");
      await new Promise(resolve => setTimeout(resolve, 50));
      // 模拟服务器的会话配置事件语义：null 清空覆盖并回到模型查表值，数字同时更新覆盖与生效值
      setConfig(current => {
        const next: ComposerConfig = {
          ...current,
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
          ...(patch.maxIterations !== undefined ? { maxIterations: patch.maxIterations } : {}),
          ...(patch.thinkingEffort !== undefined ? { thinkingEffort: patch.thinkingEffort } : {}),
          ...(patch.contextWindow !== undefined && patch.contextWindow !== null
            ? { contextWindow: patch.contextWindow, contextWindowOverride: patch.contextWindow }
            : {}),
        };
        if (patch.contextWindow === null) {
          delete next.contextWindowOverride;
          next.contextWindow = 200_000;
        }
        return next;
      });
    }} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
