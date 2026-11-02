// tests/bili_pull.test.ts
// bili_pull：本地 stub HTTP 服务器端到端（鉴权 / 校验 / 跳过 / 批量容错 / 非法响应）
// 运行: bun test ./tests/bili_pull.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createBiliPullTool } from "../src/tools/bili_pull";
import type { HubConfig } from "../src/bili/hub";

const BV = "BV1AbCdEfGh2";
const BV2 = "BV1ZzYyXxWv3";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), prefix));
}

interface Stub {
  baseUrl: string;
  hits: string[];
  stop: () => void;
}

function stubServer(handler: (req: Request, url: URL) => Response | Promise<Response>): Stub {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      hits.push(`${req.method} ${url.pathname}${url.search}`);
      return handler(req, url);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    hits,
    stop: () => server.stop(true),
  };
}

function snapshotJson(bvid = BV, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "bili-snapshot/v1",
    bvid,
    fetched_at: "2026-11-01T08:00:00Z",
    video: { title: "测试视频", desc: "", duration_s: 60, tags: [] },
    danmaku: [{ t: 1, text: "加微信" }],
    comments: [],
    ...extra,
  });
}

function hub(baseUrl: string, token?: string): HubConfig {
  return { baseUrl, timeoutMs: 3_000, ...(token !== undefined ? { token } : {}) };
}

test("bili_pull：拉单个快照，带鉴权头并原样落盘", async () => {
  const seen: { auth?: string | null } = {};
  const server = stubServer((req, url) => {
    seen.auth = req.headers.get("authorization");
    return url.pathname === `/api/snapshots/${BV}`
      ? new Response(snapshotJson(), { headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  });
  try {
    const dir = await tempDir("bili-pull-");
    const tool = createBiliPullTool({ datasetDir: dir, hub: hub(server.baseUrl, "secret") });
    const report = JSON.parse((await tool.execute({ bvid: `https://www.bilibili.com/video/${BV}/` })) as string);

    expect(seen.auth).toBe("Bearer secret");
    expect(report.mode).toBe("single");
    expect(report.failed).toHaveLength(0);
    expect(report.downloaded).toHaveLength(1);
    expect(report.downloaded[0].snapshot).toBe("downloaded");
    expect(report.downloaded[0].fetched_at).toBe("2026-11-01T08:00:00Z");

    const written = await fs.readFile(path.join(dir, `${BV}.json`), "utf8");
    expect(written).toBe(snapshotJson());
  } finally {
    server.stop();
  }
});

test("bili_pull：本地已存在默认跳过，force 才覆盖", async () => {
  let calls = 0;
  const server = stubServer(() => {
    calls++;
    return new Response(snapshotJson(BV, { fetched_at: "2026-11-02T00:00:00Z" }));
  });
  try {
    const dir = await tempDir("bili-pull-");
    await fs.writeFile(path.join(dir, `${BV}.json`), snapshotJson(BV, { fetched_at: "2026-10-01T00:00:00Z" }));
    const tool = createBiliPullTool({ datasetDir: dir, hub: hub(server.baseUrl) });

    const skipped = JSON.parse((await tool.execute({ bvid: BV })) as string);
    expect(calls).toBe(0);
    expect(skipped.downloaded[0].snapshot).toBe("skipped");
    expect(JSON.parse(await fs.readFile(path.join(dir, `${BV}.json`), "utf8")).fetched_at).toBe("2026-10-01T00:00:00Z");

    const forced = JSON.parse((await tool.execute({ bvid: BV, force: true })) as string);
    expect(calls).toBe(1);
    expect(forced.downloaded[0].snapshot).toBe("downloaded");
    expect(JSON.parse(await fs.readFile(path.join(dir, `${BV}.json`), "utf8")).fetched_at).toBe("2026-11-02T00:00:00Z");
  } finally {
    server.stop();
  }
});

test("bili_pull：快照 BV 不匹配或版本不对时拒绝落盘", async () => {
  let version = "bili-snapshot/v1";
  const server = stubServer(() => new Response(snapshotJson(BV2, { schema: version })));
  try {
    const dir = await tempDir("bili-pull-");
    const tool = createBiliPullTool({ datasetDir: dir, hub: hub(server.baseUrl) });

    const mismatch = JSON.parse((await tool.execute({ bvid: BV })) as string);
    expect(mismatch.downloaded).toHaveLength(0);
    expect(mismatch.failed[0].error).toContain("BV 号不匹配");
    expect(await fs.stat(path.join(dir, `${BV}.json`)).catch(() => undefined)).toBeUndefined();

    version = "bili-snapshot/v2";
    const wrongVersion = JSON.parse((await tool.execute({ bvid: BV2 })) as string);
    expect(wrongVersion.failed[0].error).toContain("只支持 bili-snapshot/v1");
  } finally {
    server.stop();
  }
});

test("bili_pull：列表模式只返回清单不下载", async () => {
  const server = stubServer(() =>
    new Response(
      JSON.stringify({
        items: [
          { bvid: BV, fetched_at: "2026-11-01T00:00:00Z" },
          { bvid: BV2, fetched_at: "2026-11-01T01:00:00Z" },
        ],
        next_cursor: "page-2",
      }),
    ),
  );
  try {
    const dir = await tempDir("bili-pull-");
    const tool = createBiliPullTool({ datasetDir: dir, hub: hub(server.baseUrl) });
    const report = JSON.parse((await tool.execute({ list: true, limit: 2 })) as string);

    expect(report.mode).toBe("list");
    expect(report.items).toHaveLength(2);
    expect(report.items[0].bvid).toBe(BV);
    expect(report.next_cursor).toBe("page-2");
    expect(report.downloaded).toBeUndefined();
    expect(server.hits[0]).toContain("limit=2");
  } finally {
    server.stop();
  }
});

test("bili_pull：批量拉取单条失败不拖垮整批，并透传游标", async () => {
  const server = stubServer((_req, url) => {
    if (url.pathname === "/api/snapshots") {
      return new Response(
        JSON.stringify({
          items: [
            { bvid: BV, fetched_at: "2026-11-01T00:00:00Z" },
            { bvid: BV2, fetched_at: "2026-11-01T01:00:00Z" },
            { bvid: BV, fetched_at: "2026-11-01T02:00:00Z" },
          ],
          next_cursor: "page-2",
        }),
      );
    }
    if (url.pathname === `/api/snapshots/${BV}`) return new Response(snapshotJson(BV));
    return new Response("boom", { status: 500 });
  });
  try {
    const dir = await tempDir("bili-pull-");
    const tool = createBiliPullTool({ datasetDir: dir, hub: hub(server.baseUrl) });
    const report = JSON.parse(
      (await tool.execute({ since: "2026-10-31T00:00:00Z", limit: 10 })) as string,
    );

    expect(report.mode).toBe("batch");
    expect(report.next_cursor).toBe("page-2");
    expect(report.downloaded).toHaveLength(1);
    expect(report.downloaded[0].bvid).toBe(BV);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].bvid).toBe(BV2);
    expect(report.failed[0].error).toContain("500");
    expect(server.hits[0]).toContain(`since=${encodeURIComponent("2026-10-31T00:00:00Z")}`);
  } finally {
    server.stop();
  }
});

test("bili_pull：非 JSON / 坏快照记失败且不落盘", async () => {
  const server = stubServer((_req, url) =>
    url.pathname === `/api/snapshots/${BV}`
      ? new Response("<html>gateway error</html>", { headers: { "content-type": "text/html" } })
      : new Response(JSON.stringify({ foo: 1 })),
  );
  try {
    const dir = await tempDir("bili-pull-");
    const tool = createBiliPullTool({ datasetDir: dir, hub: hub(server.baseUrl) });

    const html = JSON.parse((await tool.execute({ bvid: BV })) as string);
    expect(html.failed[0].error).toContain("不是合法 JSON");

    const shape = JSON.parse((await tool.execute({ bvid: BV2 })) as string);
    expect(shape.failed[0].error).toContain("不符合 bili-snapshot/v1");
    expect(await fs.stat(path.join(dir, `${BV}.json`)).catch(() => undefined)).toBeUndefined();
  } finally {
    server.stop();
  }
});

test("bili_pull：未配置 BILI_HUB_URL 时给出可读指引", async () => {
  const dir = await tempDir("bili-pull-");
  const tool = createBiliPullTool({ datasetDir: dir, env: {} });
  await expect(tool.execute({ bvid: BV })).rejects.toThrow("BILI_HUB_URL");
});
