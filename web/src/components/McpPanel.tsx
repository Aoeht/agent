// web/src/components/McpPanel.tsx
/**
 * MCP 目录面板：把 MCP 的 resources / prompts 做成可浏览的入口。
 *
 * - 资源：列表来自 GET /mcp/catalog，选中后经 GET /mcp/resource 预览正文；
 *   "注入下一轮"把 /resource <serverId:uri> 交回聊天命令通道——与手敲命令同一段
 *   服务端逻辑（不可信资料围栏、一次性消费），面板不复制一份注入实现。
 * - 提示模板：列出参数表单，载入时发 /prompt <serverId:name> {JSON}，同样复用命令通道。
 * 回合进行中不提供注入/载入按钮（服务端会拒绝变更类命令）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  McpCatalogDTO,
  McpPromptSummaryDTO,
  McpResourceReadDTO,
  McpResourceSummaryDTO,
} from "@protocol";
import { useStore } from "../state/store";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const tabBtn = "rounded-full px-3 py-1 text-xs transition";

export function McpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { current, actions } = useStore();
  const [catalog, setCatalog] = useState<McpCatalogDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<"resources" | "prompts">("resources");
  const [picked, setPicked] = useState<McpResourceSummaryDTO | null>(null);
  const [preview, setPreview] = useState<McpResourceReadDTO | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const [prompt, setPrompt] = useState<McpPromptSummaryDTO | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  // 连续点击不同资源时只认最后一次请求的结果
  const previewSeq = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setCatalog(await actions.listMcpCatalog());
      setError(undefined);
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [actions]);

  // 打开时重置本地状态并拉最新清单；关掉即丢弃（目录不做全局缓存）
  useEffect(() => {
    if (!open) return;
    setCatalog(null);
    setError(undefined);
    setNotice(undefined);
    setTab("resources");
    setPicked(null);
    setPreview(null);
    setPreviewError(undefined);
    setPrompt(null);
    setArgs({});
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const running = current !== null && current.status !== "idle";
  const resources = catalog?.resources ?? [];
  const prompts = catalog?.prompts ?? [];

  const pickResource = async (resource: McpResourceSummaryDTO): Promise<void> => {
    setPicked(resource);
    setPreview(null);
    setPreviewError(undefined);
    setNotice(undefined);
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    try {
      const result = await actions.readMcpResource(resource.serverId, resource.uri);
      if (seq === previewSeq.current) setPreview(result);
    } catch (readError) {
      if (seq === previewSeq.current) setPreviewError(messageOf(readError));
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  const inject = async (): Promise<void> => {
    if (picked === null || running) return;
    setSending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await actions.send(`/resource ${picked.serverId}:${picked.uri}`);
      setNotice(`已注入 ${picked.name}：下一轮作为不可信参考资料带上（命令结果见对话里的 ⌨️ 卡片）。`);
    } catch (sendError) {
      setError(messageOf(sendError));
    } finally {
      setSending(false);
    }
  };

  const loadPrompt = async (): Promise<void> => {
    if (prompt === null || running) return;
    const missing = prompt.arguments
      .filter((arg) => arg.required === true && (args[arg.name] ?? "").trim() === "")
      .map((arg) => arg.name);
    if (missing.length > 0) {
      setError(`必填参数为空：${missing.join(", ")}`);
      return;
    }
    const provided: Record<string, string> = {};
    for (const arg of prompt.arguments) {
      const value = (args[arg.name] ?? "").trim();
      if (value !== "") provided[arg.name] = value;
    }
    const suffix = Object.keys(provided).length > 0 ? ` ${JSON.stringify(provided)}` : "";
    setSending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await actions.send(`/prompt ${prompt.serverId}:${prompt.name}${suffix}`);
      setNotice(`已载入模板 ${prompt.serverId}:${prompt.name}：后续每轮以独立消息注入，空 /prompt 清除。`);
    } catch (sendError) {
      setError(messageOf(sendError));
    } finally {
      setSending(false);
    }
  };

  const actionBtn =
    "rounded-full border border-clay-500/60 px-3 py-1 text-xs text-clay-600 transition hover:bg-cream-50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-label="MCP 目录"
    >
      <div className="flex h-[min(82vh,760px)] w-[min(860px,96vw)] flex-col overflow-hidden rounded-2xl border border-cream-300 bg-cream-100 shadow-xl">
        <header className="flex items-center gap-3 border-b border-cream-300 bg-cream-50 px-4 py-3">
          <h2 className="text-sm font-semibold">🧩 MCP 目录</h2>
          <div className="flex items-center gap-1">
            <button
              className={`${tabBtn} ${tab === "resources" ? "bg-cream-200 text-ink-900" : "text-ink-400 hover:text-ink-600"}`}
              onClick={() => setTab("resources")}
            >
              资源（{resources.length}）
            </button>
            <button
              className={`${tabBtn} ${tab === "prompts" ? "bg-cream-200 text-ink-900" : "text-ink-400 hover:text-ink-600"}`}
              onClick={() => setTab("prompts")}
            >
              提示模板（{prompts.length}）
            </button>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-2 py-1 text-sm text-ink-600 transition hover:bg-cream-200"
            title="关闭（Esc）"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-3">
          {catalog === null && loading ? (
            <p className="px-2 py-4 text-xs text-ink-400">读取 MCP 目录…</p>
          ) : (
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
              <div className="min-h-0 overflow-y-auto rounded-xl border border-cream-300 bg-cream-100 p-1">
                {tab === "resources" ? (
                  resources.length === 0 ? (
                    <p className="px-2 py-4 text-xs leading-5 text-ink-400">
                      （没有 server 暴露 resources）
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {resources.map((resource) => {
                        const active =
                          picked !== null && picked.serverId === resource.serverId && picked.uri === resource.uri;
                        return (
                          <li key={`${resource.serverId}:${resource.uri}`}>
                            <button
                              onClick={() => void pickResource(resource)}
                              className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                                active
                                  ? "border-clay-500/60 bg-cream-50 shadow-sm"
                                  : "border-transparent hover:border-cream-300 hover:bg-cream-50/70"
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate text-xs font-medium text-ink-900">{resource.name}</span>
                                <span className="shrink-0 rounded-full bg-cream-200 px-2 py-0.5 font-mono text-[10px] text-ink-600">
                                  {resource.serverId}
                                </span>
                              </div>
                              <div className="mt-1 truncate font-mono text-[10px] text-ink-400">{resource.uri}</div>
                              {(resource.description !== undefined || resource.mimeType !== undefined) && (
                                <div className="mt-1 truncate text-[11px] text-ink-400">
                                  {[resource.mimeType, resource.description].filter(Boolean).join(" · ")}
                                </div>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : prompts.length === 0 ? (
                  <p className="px-2 py-4 text-xs leading-5 text-ink-400">
                    （没有 server 暴露 prompts 模板）
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {prompts.map((item) => {
                      const active = prompt !== null && prompt.serverId === item.serverId && prompt.name === item.name;
                      return (
                        <li key={`${item.serverId}:${item.name}`}>
                          <button
                            onClick={() => {
                              setPrompt(item);
                              setArgs({});
                              setError(undefined);
                              setNotice(undefined);
                            }}
                            className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                              active
                                ? "border-clay-500/60 bg-cream-50 shadow-sm"
                                : "border-transparent hover:border-cream-300 hover:bg-cream-50/70"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="truncate text-xs font-medium text-ink-900">{item.name}</span>
                              <span className="shrink-0 rounded-full bg-cream-200 px-2 py-0.5 font-mono text-[10px] text-ink-600">
                                {item.serverId}
                              </span>
                            </div>
                            {item.description !== undefined && (
                              <div className="mt-1 truncate text-[11px] text-ink-400">{item.description}</div>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="flex min-h-0 flex-col rounded-xl border border-cream-300 bg-cream-100">
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {tab === "resources" ? (
                    picked === null ? (
                      <p className="text-xs leading-5 text-ink-400">
                        选一条资源查看正文。资源是外部数据，注入时按不可信资料围栏处理，只带下一轮。
                      </p>
                    ) : previewLoading ? (
                      <p className="text-xs text-ink-400">读取资源…</p>
                    ) : previewError !== undefined ? (
                      <p className="rounded-lg bg-terra-100 px-3 py-2 text-xs text-terra-500">{previewError}</p>
                    ) : preview === null || preview.contents.length === 0 ? (
                      <p className="text-xs text-ink-400">（资源内容为空）</p>
                    ) : (
                      <div className="space-y-3">
                        {preview.contents.map((content, index) => (
                          <div key={index}>
                            <div className="mb-1 flex items-center gap-2 text-[10px] text-ink-400">
                              <span className="font-mono">{content.mimeType ?? "未知类型"}</span>
                              <span className="truncate font-mono">{content.uri}</span>
                              {content.truncated === true && <span>· 已截断</span>}
                            </div>
                            {"text" in content && content.text !== undefined ? (
                              <pre className="whitespace-pre-wrap break-words rounded-lg bg-ink-900 px-3 py-2 font-mono text-[11px] leading-5 text-cream-100">
                                {content.text}
                              </pre>
                            ) : (
                              <p className="rounded-lg bg-cream-200 px-3 py-2 text-xs text-ink-600">
                                二进制内容（{formatBytes(content.blobBytes ?? 0)}），不支持预览，也无法注入文本通道。
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                  ) : prompt === null ? (
                    <p className="text-xs leading-5 text-ink-400">
                      选一个提示模板，填参数后载入。模板是指令不是资料：system 约束留在 System 层，正文每轮独立注入。
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-ink-900">{prompt.name}</span>
                          <span className="rounded-full bg-cream-200 px-2 py-0.5 font-mono text-[10px] text-ink-600">
                            {prompt.serverId}
                          </span>
                        </div>
                        {prompt.description !== undefined && (
                          <p className="mt-1 text-[11px] leading-5 text-ink-400">{prompt.description}</p>
                        )}
                      </div>
                      {prompt.arguments.length === 0 ? (
                        <p className="text-[11px] text-ink-400">该模板无参数。</p>
                      ) : (
                        <div className="space-y-2">
                          {prompt.arguments.map((arg) => (
                            <label key={arg.name} className="block">
                              <span className="mb-1 block text-[11px] text-ink-600">
                                {arg.name}
                                {arg.required === true ? " *" : ""}
                                {arg.description !== undefined && (
                                  <span className="ml-1 text-ink-400">— {arg.description}</span>
                                )}
                              </span>
                              <input
                                value={args[arg.name] ?? ""}
                                onChange={(event) => setArgs((prev) => ({ ...prev, [arg.name]: event.target.value }))}
                                className="w-full rounded-lg border border-cream-300 bg-cream-50 px-2 py-1 text-xs text-ink-900 outline-none focus:border-clay-500/60"
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      <button className={actionBtn} disabled={running || sending} onClick={() => void loadPrompt()}>
                        {sending ? "载入中…" : "载入模板"}
                      </button>
                    </div>
                  )}
                </div>

                {tab === "resources" && picked !== null && (
                  <div className="border-t border-cream-300 bg-cream-50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[11px] text-ink-400">
                        {running ? "回合进行中，结束后再注入" : "注入后只影响下一轮"}
                      </span>
                      <button
                        className={`ml-auto ${actionBtn}`}
                        disabled={running || sending || previewLoading}
                        onClick={() => void inject()}
                      >
                        {sending ? "注入中…" : "注入下一轮"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="space-y-2 border-t border-cream-300 bg-cream-50 px-4 py-3">
          {catalog?.errors !== undefined && catalog.errors.length > 0 && (
            <p className="rounded-lg bg-terra-100 px-3 py-2 text-[11px] text-terra-500">
              {catalog.errors.join("；")}
            </p>
          )}
          {error !== undefined && (
            <p className="rounded-lg bg-terra-100 px-3 py-2 text-xs text-terra-500">{error}</p>
          )}
          {notice !== undefined && (
            <p className="rounded-lg bg-cream-200 px-3 py-2 text-[11px] text-ink-600">{notice}</p>
          )}
          <p className="text-[11px] text-ink-400">
            注入/载入都走聊天命令通道（/resource、/prompt）：输出出现在对话里的 ⌨️ 命令卡，与本面板同一份逻辑。
          </p>
        </footer>
      </div>
    </div>
  );
}
