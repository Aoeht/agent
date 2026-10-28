// web/tests/fixtures/attachments.tsx
// 附件交互夹具：真实 Composer + 记录 onSend 的文本与图片元数据，不连后端。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/components/Composer";
import type { SessionConfigInput } from "../../src/lib/transport";

function Fixture() {
  const [vision, setVision] = useState<boolean | undefined>(true);
  const fixture = ((window as any).fixture ??= { entries: [] as unknown[] });
  fixture.setVision = setVision;
  return (
    <Composer
      sessionId="a"
      running={false}
      disabled={false}
      models={["test-model"]}
      config={{ model: "test-model" }}
      visionCapable={vision}
      onSend={(text, images) => {
        fixture.entries.push({
          text,
          images: images.map(image => ({ name: image.name, mimeType: image.mimeType, sizeBytes: image.sizeBytes })),
        });
      }}
      onCancel={() => {}}
      onApplyConfig={async (_config: SessionConfigInput) => {}}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
