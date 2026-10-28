import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpAdapter } from "../src/mcp/adapter";
import { McpClientManager } from "../src/mcp/client_manager";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

test("真实 filesystem MCP：图片经附件通道传递，structuredContent 副本不进入文本", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-filesystem-image-"));
  const adapter = new McpAdapter({ allowedRoots: [root] });
  const manager = new McpClientManager(adapter);
  try {
    await fs.writeFile(path.join(root, "pixel.png"), Buffer.from(png, "base64"));
    await manager.addServer({
      id: "filesystem", transport: "stdio", command: process.execPath,
      args: ["run", fileURLToPath(import.meta.resolve("@modelcontextprotocol/server-filesystem/dist/index.js")), root],
      roots: [root], requestTimeoutMs: 20_000,
    });
    for (const accepting of [true, false]) {
      const images: string[] = [];
      const result = await adapter.registry.execute("filesystem__read_media_file", { path: path.join(root, "pixel.png") }, {
        emitImage: image => { if (accepting) images.push(image.dataUrl); return accepting; },
      });
      expect(images).toHaveLength(accepting ? 1 : 0);
      expect(result).not.toContain(png);
      expect(result).toContain(accepting ? "已附加" : "未附加");
      const parsed = JSON.parse(result);
      expect(parsed.structuredContent.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(parsed.structuredContent.content[0].data).toContain("已省略");
      if (accepting) expect(images[0]).toBe(`data:image/png;base64,${png}`);
    }
    const withoutChannel = await adapter.registry.execute("filesystem__read_media_file", { path: path.join(root, "pixel.png") });
    expect(withoutChannel).toContain("没有图片通道");
    expect(withoutChannel).not.toContain(png);
  } finally {
    await manager.closeAll();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
