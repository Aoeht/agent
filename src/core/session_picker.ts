// src/core/session_picker.ts
import { SessionStore } from "./session_store";

export interface PickedSession {
  store: SessionStore;
  sessionId: string;
  /** true 表示新会话：文件在第一次 append 时才真正落盘 */
  isNew: boolean;
}

export interface NewSessionOptions {
  /** 测试注入用；缺省按当前时间生成 session-YYYYMMDD-HHmmss-xxxx */
  generateId?: () => string;
  /** 输出通道，缺省 console.log */
  log?: (line: string) => void;
}

export interface PickSessionOptions extends NewSessionOptions {
  dir: string;
  /** 向用户提问并拿回一行输入（CLI 里接 readline，测试里接脚本答案） */
  ask: (question: string) => Promise<string>;
}

/** 秒级时间戳 + 4 位随机后缀：UI 可以在同一秒内连开多个会话，纯秒级时间戳会撞 ID */
export function createSessionId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `session-${date}-${time}-${suffix}`;
}

/** 开新会话：只构造 SessionStore，不建文件 */
export function newSession(dir: string, options: NewSessionOptions = {}): PickedSession {
  const sessionId = (options.generateId ?? createSessionId)();
  options.log?.(`🆕 新会话: ${sessionId}`);
  return { store: new SessionStore({ dir, sessionId }), sessionId, isNew: true };
}

/**
 * 在调用大模型前先问一句：续聊哪个已有会话，还是直接开新会话。
 * 菜单编号从 1 开始，[0]/回车 = 新会话；非法输入重问。
 */
export async function pickSession(options: PickSessionOptions): Promise<PickedSession> {
  const log = options.log ?? console.log;
  const sessions = await SessionStore.list(options.dir);
  if (sessions.length === 0) return newSession(options.dir, options);

  log("可用会话：");
  log("  [0] 新建会话");
  sessions.forEach((session, index) => {
    // 有会话名时名字打头（更好认），sessionId 仍保留 —— 它就是文件名，续聊/排查都要用
    const title = session.name !== undefined ? `${session.name} · ${session.sessionId}` : session.sessionId;
    log(
      `  [${index + 1}] ${title} · ${session.messageCount} 条消息 · 最后更新 ${formatTime(session.lastUpdated)}`
    );
    log(`      ↳ ${session.firstUserText}`);
  });

  while (true) {
    const answer = (await options.ask("请选择要续聊的会话编号（直接回车开新会话）: ")).trim();
    if (answer === "" || answer === "0") return newSession(options.dir, options);

    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= sessions.length) {
      const picked = sessions[index - 1]!;
      const title = picked.name !== undefined ? `${picked.name}（${picked.sessionId}）` : picked.sessionId;
      log(`📂 续聊会话: ${title}（${picked.messageCount} 条历史消息）`);
      return {
        store: new SessionStore({ dir: options.dir, sessionId: picked.sessionId }),
        sessionId: picked.sessionId,
        isNew: false,
      };
    }
    log(`⚠️ 无效编号 "${answer}"，请输入 0-${sessions.length}`);
  }
}

function formatTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
