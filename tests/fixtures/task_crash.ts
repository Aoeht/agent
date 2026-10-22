import fs from "node:fs";
import path from "node:path";
import { TaskStore } from "../../src/core/task_store";
const root = process.argv[2]!;
const store = new TaskStore(path.join(root, "task.sqlite"));
store.begin("创建一次产物", { workspace: root });
store.setPlan([{ content: "生成文件", status: "in_progress" }]);
store.startAction("write_once", '{"path":"marker.txt"}');
fs.appendFileSync(path.join(root, "marker.txt"), "executed\n");
// Terminate after the external side effect and before its result is committed.
process.exit(23);
