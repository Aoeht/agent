import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/components/Composer";
import type { SessionConfigInput } from "../../src/lib/transport";

function Fixture() {
  const [sessionId, setSessionId] = useState("a");
  const [config, setConfig] = useState({ model: "old", temperature: 0.1, maxIterations: 8 });
  const fixture = (window as any).fixture ??= { submissions: [], fail: false };
  fixture.update = setConfig;
  fixture.switchSession = setSessionId;
  return <Composer sessionId={sessionId} running={false} disabled={false}
    models={["old", "chosen", "late"]} config={config} onSend={() => {}} onCancel={() => {}}
    onApplyConfig={async (patch: SessionConfigInput) => {
      fixture.submissions.push({ sessionId, ...patch });
      if (fixture.fail) throw new Error("保存失败，请重试");
      await new Promise(resolve => setTimeout(resolve, 50));
      setConfig(current => ({ ...current, ...patch }));
    }} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
