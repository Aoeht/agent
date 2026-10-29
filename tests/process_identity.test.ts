import { describe, expect, test } from "bun:test";
import { isSameProcess, ownProcessStartedAt, processStartedAt } from "../src/core/process_identity";

describe("process identity", () => {
  test("系统探针与本进程记录一致", () => {
    const probed = processStartedAt(process.pid);
    // 平台不支持探测时（返回 undefined）只能退回只看存活，这里没有可断言的
    if (probed === undefined) return;
    expect(Math.abs(probed - ownProcessStartedAt())).toBeLessThan(2_000);
  });

  test("pid 存活但启动时间不符：判为不是同一进程", () => {
    const self = ownProcessStartedAt();
    expect(isSameProcess(process.pid, self)).toBe(true);
    expect(isSameProcess(process.pid, self - 3_600_000)).toBe(false);
  });

  test("旧记录没有启动时间、或探测不可用时退回只看存活", () => {
    expect(isSameProcess(process.pid, undefined)).toBe(true);
  });
});
