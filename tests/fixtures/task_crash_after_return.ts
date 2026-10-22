import fs from "node:fs";
import path from "node:path";
import { TaskStore } from "../../src/core/task_store";
const root = process.argv[2]!;
const store = new TaskStore(path.join(root, "task.sqlite"));
store.begin("写一次产物", { workspace: root });
const action = store.startAction("write_once", '{"path":"marker.txt"}');
fs.appendFileSync(path.join(root, "marker.txt"), "executed\n");
store.endAction(action, "executed");
// Die after the tool returned but before the run reached finish(): the owner stays behind.
process.exit(24);
