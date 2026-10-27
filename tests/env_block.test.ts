import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/prompts/system";
import { parseGitStatus, renderEnvBlock, snapshotEnv, type EnvSnapshot } from "../src/prompts/env_block";
import type { SkillManifest } from "../src/skills/loader";

// 当地时间正午（无时区后缀 → 按本地时区解析）：日历日期与星期在任意机器时区下都确定
const FIXED = new Date("2026-10-27T12:00:00");

const SAMPLE: EnvSnapshot = {
  currentDate: "2026-10-27（周二，UTC+8）",
  os: "Windows 10.0.19045（x64）",
  cwd: "A:\\ai_agent",
  git: "分支 main，2 处未提交变更",
};

const SKILL: SkillManifest = {
  name: "demo",
  description: "演示技能",
  dir: "/tmp/skills/demo",
  files: [],
};

describe("snapshotEnv", () => {
  test("日期快照：日历日期与星期确定（与机器时区无关），含 UTC 偏移", () => {
    const snap = snapshotEnv("/tmp/ws", { now: FIXED, withGit: false });
    expect(snap.currentDate).toContain("2026-10-27");
    expect(snap.currentDate).toContain("周二");
    expect(snap.currentDate).toMatch(/UTC[+-]\d{1,2}/);
  });

  test("withGit:false 跳过 git 查询，git 为 null，其余字段齐全", () => {
    const snap = snapshotEnv("/tmp/ws", { now: FIXED, withGit: false });
    expect(snap.git).toBeNull();
    expect(snap.os.length).toBeGreaterThan(0);
    expect(snap.cwd).toBe(process.cwd());
  });
});

describe("parseGitStatus（git status --porcelain=v2 --branch）", () => {
  test("分支 + 领先/落后 + 未提交变更数", () => {
    const out = [
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 abc abc src/a.ts",
      "? new.txt",
    ].join("\n");
    expect(parseGitStatus(out)).toBe("分支 main，领先上游 2、落后 1，2 处未提交变更");
  });

  test("干净工作区（无上游、无条目）", () => {
    expect(parseGitStatus("# branch.oid abc\n# branch.head main")).toBe("分支 main，工作区干净");
  });

  test("有上游但 0/0 不显示领先落后", () => {
    expect(parseGitStatus("# branch.head main\n# branch.ab +0 -0")).toBe("分支 main，工作区干净");
  });

  test("游离 HEAD", () => {
    expect(parseGitStatus("# branch.head (detached)\n1 .M N... src/a.ts")).toBe(
      "处于游离 HEAD（不挂在任何分支上），1 处未提交变更"
    );
  });

  test("解析不动的形状一律 null（宁可整行省略）", () => {
    expect(parseGitStatus("")).toBeNull();
    expect(parseGitStatus("fatal: not a git repository")).toBeNull();
    expect(parseGitStatus("garbage lines\nwithout headers")).toBeNull();
  });
});

describe("renderEnvBlock", () => {
  test("含日期/系统/cwd/git 四行，末行是 git", () => {
    const block = renderEnvBlock(SAMPLE);
    expect(block).toContain("【运行环境】");
    expect(block).toContain("- 当前日期：2026-10-27（周二，UTC+8）");
    expect(block).toContain("- 操作系统：Windows 10.0.19045（x64）");
    expect(block).toContain("- 宿主工作目录：A:\\ai_agent");
    expect(block).toContain("- 工作区 git：分支 main，2 处未提交变更");
    expect(block.trimEnd().endsWith("分支 main，2 处未提交变更")).toBe(true);
  });

  test("git 为 null 时整行省略（不是仓库时环境块照常渲染）", () => {
    const block = renderEnvBlock({ ...SAMPLE, git: null });
    expect(block).not.toContain("git：");
    expect(block).toContain("- 当前日期：");
    expect(block).toContain("- 宿主工作目录：");
  });

  test("同一快照渲染结果逐字节一致（进系统提示，必须确定）", () => {
    expect(renderEnvBlock(SAMPLE)).toBe(renderEnvBlock(SAMPLE));
  });
});

describe("buildSystemPrompt 接线", () => {
  test("env 块渲染在最末尾（静态规则与技能段之后，保住跨会话前缀缓存）", () => {
    const prompt = buildSystemPrompt("/tmp/ws", [SKILL], { env: SAMPLE });
    const skillsAt = prompt.indexOf("【可用技能】");
    const envAt = prompt.indexOf("【运行环境】");
    expect(skillsAt).toBeGreaterThan(-1);
    expect(envAt).toBeGreaterThan(skillsAt);
    expect(prompt.trimEnd().endsWith("分支 main，2 处未提交变更")).toBe(true);
  });

  test("不传 env：无环境块，也不再有写死的 Windows 行；工作区根目录仍在", () => {
    const prompt = buildSystemPrompt("/tmp/ws");
    expect(prompt).not.toContain("【运行环境】");
    expect(prompt).not.toContain("当前系统: Windows");
    expect(prompt).toContain('工作区根目录: "/tmp/ws"');
  });

  test("同一 env 快照下提示词逐字节一致（会话内稳定，不破坏前缀缓存）", () => {
    const a = buildSystemPrompt("/tmp/ws", [SKILL], { env: SAMPLE });
    const b = buildSystemPrompt("/tmp/ws", [SKILL], { env: SAMPLE });
    expect(a).toBe(b);
  });
});
