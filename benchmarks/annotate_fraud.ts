/** bun run benchmarks/annotate_fraud.ts --help */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import OpenAI from "openai";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  ANNOTATION_VERSION, ANNOTATION_PROMPT, TaskSchema, taskHash, fingerprint,
  validateObservation, reviewReasons, validateReview, type AnnotationTask, type LabelRecord,
} from "../src/bili/annotation";

const HELP = `证据标注 ${ANNOTATION_VERSION}（本地任务/教师预标/人工核验，原库只读）
prepare --db FILE --segments FILE --out DIR [--asset-root DIR] [--bvid BV] [--limit 5]
  默认5个视频，--limit 0 全部。segments 为已有30s拼图清单；未覆盖视频会明确记录缺视频材料。
  评论按合并历史并集导出，不声称是当前全量；不抽样/不截正文。需在人工复核时确定评估快照口径。
run --out DIR --model MODEL --base-url URL [--limit 5] [--go]
  默认仅打印请求样例。--go 才联网，使用 ANNOTATION_API_KEY；没有默认模型/端点。
  教师仅提取证据，严格校验后保存；失败纠正一次。图片只用本地文件，不自动下载URL。
review --out DIR --model MODEL
  为已有预标生成人工复核模板和证据包；已有模板不覆盖。无付费请求。
check --out DIR --model MODEL
  校验人工填写的 reviews/*.json，输出 adjudicated.jsonl 和 check.json；无效记录不能进入结果。
通用：--out 默认 work/fraud-annotation-v2；所有输出均含输入版本哈希；模型结果始终是待人工复核。
`;

const SegmentSchema = z.object({
  bvid: z.string(), segment_index: z.number().int().nonnegative(),
  start_s: z.number().finite().nonnegative(), end_s: z.number().finite().positive(), grid_path: z.string(),
  cells: z.array(z.object({ index: z.number().int().min(1).max(9), t: z.number().finite().nonnegative() })).length(9),
  asr_text: z.string(),
});
async function jsonl(file: string): Promise<any[]> {
  const content = await fs.readFile(file, "utf8");
  return content.split(/\r?\n/).filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${file}:${i + 1} JSON 损坏，请先修复（不忽略断尾）`); }
  });
}
async function optionalJsonl(file: string): Promise<any[]> {
  try { return await jsonl(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
const fileHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function mime(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP") return "image/webp";
  throw new Error("仅接受实际 JPEG/PNG/WebP 图像，不发送非图像文件");
}
type Options = ReturnType<typeof options>;
function options() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: "boolean" }, go: { type: "boolean" },
    db: { type: "string", default: "video_metadata/merged_20261110/bili_merged_v1.sqlite3" },
    segments: { type: "string", default: "work/train-segments-30s/segments.jsonl" },
    out: { type: "string", default: "work/fraud-annotation-v2" },
    "asset-root": { type: "string", default: "." }, bvid: { type: "string" },
    limit: { type: "string", default: "5" }, model: { type: "string" }, "base-url": { type: "string" },
  } });
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("limit 必须为非负整数");
  return { ...values, command: positionals[0], limit, out: path.resolve(values.out), assetRoot: path.resolve(values["asset-root"]) };
}

async function prepare(args: Options) {
  await fs.mkdir(args.out, { recursive: true });
  // Never replace a prepared dataset underneath existing observations/reviews.
  const output = await fs.open(path.join(args.out, "tasks.jsonl"), "wx");
  const segments = (await jsonl(args.segments)).map(r => SegmentSchema.parse(r));
  const byVideo = new Map<string, typeof segments>();
  for (const s of segments) {
    if (s.end_s <= s.start_s || new Set(s.cells.map(c => c.index)).size !== 9 ||
      s.cells.some(c => c.t < s.start_s || c.t >= s.end_s)) throw new Error(`非法段映射 ${s.bvid}#${s.segment_index}`);
    byVideo.set(s.bvid, [...(byVideo.get(s.bvid) ?? []), s]);
  }
  const db = new Database(args.db, { readonly: true });
  db.exec("BEGIN");
  const summaries: any[] = [];
  let count = 0;
  async function image(source_id: string, rawPath: string | undefined, limitations: string[]) {
    if (!rawPath || /^https?:/i.test(rawPath)) {
      limitations.push(`${source_id}: 附图缺少本地路径，未读取`);
      return { source_id, path: rawPath || "[missing-local-image]", sha256: null };
    }
    const local = path.resolve(args.assetRoot, rawPath);
    try {
      const bytes = await fs.readFile(local); mime(bytes);
      return { source_id, path: local, sha256: fileHash(bytes) };
    } catch { limitations.push(`${source_id}: 附图不存在或格式不支持，未读取`); return { source_id, path: local, sha256: null }; }
  }
  async function emit(task: AnnotationTask) {
    TaskSchema.parse(task);
    await output.write(JSON.stringify(task) + "\n"); count++;
  }
  try {
    const videos = db.query(`SELECT bv,title,introduction,owner_mid,availability FROM videos
      ${args.bvid ? "WHERE bv=?" : ""} ORDER BY bv ${args.limit ? "LIMIT ?" : ""}`).all(
        ...[...(args.bvid ? [args.bvid] : []), ...(args.limit ? [args.limit] : [])]) as any[];
    if (!videos.length) throw new Error("未选择到视频");
    for (const v of videos) {
      const base = { version: ANNOTATION_VERSION, bvid: v.bv } as const;
      const sources: AnnotationTask["sources"] = [];
      const comments = db.query(`SELECT rpid,root_rpid,parent_rpid,mid,content,is_up,is_pinned,in_latest_full,
        last_observed_at,last_snapshot_at,source,images_json FROM comments WHERE bv=? ORDER BY root_rpid,rpid`).all(v.bv) as any[];
      const coverage = db.query("SELECT source,reply_scope,main_end_reached,exported_at FROM comment_stats WHERE bv=?").all(v.bv);
      const owner = v.owner_mid ? db.query("SELECT signature FROM authors WHERE mid=?").get(v.owner_mid) as any : null;
      sources.push({ id: "metadata", kind: "metadata", speaker: "author", text: JSON.stringify({ title: v.title,
        introduction: v.introduction, signature: owner?.signature ?? "" }), parent: null, root: null, start_s: null, end_s: null, cells: [] });
      await emit({ ...base, id: `${v.bv}#metadata`, sources: [...sources], images: [], limitations: ["仅标题、简介和签名，不含封面及作者身份核验"] });
      let batch: AnnotationTask["sources"] = [], images: AnnotationTask["images"] = [], limitations: string[] = [], batchNo = 0;
      async function flush() {
        if (!batch.length) return;
        await emit({ ...base, id: `${v.bv}#comments-${++batchNo}`, sources: batch, images,
          limitations: ["合并历史并集，不代表同一时刻全量评论；跨批父链见同视频证据包，不推断缺失关系", ...limitations] });
        batch = []; images = []; limitations = [];
      }
      for (const c of comments) {
        const pics = c.images_json ? JSON.parse(c.images_json) : [];
        if (!Array.isArray(pics)) throw new Error(`非法 images_json ${c.rpid}`);
        if (batch.length && (batch.length >= 20 || batch.reduce((n,s)=>n+s.text.length,0) + (c.content ?? "").length > 16000 || images.length + pics.length > 9)) await flush();
        const id = `comment:${c.rpid}`;
        batch.push({ id, kind: "comment", speaker: c.is_up === 1 || (v.owner_mid && c.mid === v.owner_mid) ? "author" : `commenter:${c.mid || c.rpid}`,
          text: c.content ?? "", parent: c.parent_rpid ?? null, root: c.root_rpid ?? null, start_s: null, end_s: null, cells: [] });
        // Metadata is separate from text and must not be mistaken for a quoted user's statement.
        limitations.push(`${id}: source=${c.source}, latest=${c.in_latest_full}, pinned=${c.is_pinned}, observed=${c.last_observed_at}, snapshot=${c.last_snapshot_at}`);
        for (const p of pics) {
          const item = await image(id, typeof p === "string" ? p : p.local_path, limitations);
          if (item) images.push(item);
        }
      }
      await flush();
      const dm = db.query("SELECT dmid,offset_seconds,text FROM danmaku WHERE bv=? ORDER BY offset_seconds,dmid").all(v.bv) as any[];
      for (let i = 0; i < dm.length; i += 100) await emit({ ...base, id: `${v.bv}#danmaku-${i / 100 + 1}`, images: [],
        limitations: ["弹幕发言者不等同视频作者；不将弹幕举报当核实事实"], sources: dm.slice(i, i + 100).map(d => ({
          id: `danmaku:${d.dmid}`, kind: "danmaku", speaker: "unknown", text: d.text ?? "", parent: null, root: null,
          start_s: d.offset_seconds, end_s: d.offset_seconds, cells: [],
        })) });
      const segs = (byVideo.get(v.bv) ?? []).sort((a,b)=>a.start_s-b.start_s);
      for (const s of segs) {
        const id = `segment:${s.segment_index}`, issues: string[] = [];
        if (!s.asr_text.trim()) issues.push("ASR为空：可能无语音或识别失败，不推断为无风险");
        const img = await image(id, s.grid_path, issues);
        await emit({ ...base, id: `${v.bv}#segment-${s.segment_index}`, images: img ? [img] : [], limitations: issues,
          sources: [{ id, kind: "segment", speaker: "author", text: s.asr_text, start_s: s.start_s, end_s: s.end_s,
            parent: null, root: null, cells: s.cells }] });
      }
      summaries.push({ bvid: v.bv, comments: comments.length, danmaku: dm.length, segments: segs.length,
        segment_gaps: segs.flatMap((s,i) => s.start_s > (segs[i-1]?.end_s ?? 0) + .01 ? [{ from: segs[i-1]?.end_s ?? 0, to: s.start_s }] : []),
        availability: v.availability, collection: coverage,
        limitations: ["输入是所选材料集合，不保证全片/当前评论完整", ...(!segs.length ? ["无视频拼图材料"] : [])] });
    }
    await fs.writeFile(path.join(args.out, "prepare.json"), JSON.stringify({ version: ANNOTATION_VERSION,
      db: path.resolve(args.db), segments: path.resolve(args.segments), prepared_at: new Date().toISOString(), videos: summaries, tasks: count }, null, 2));
    await fs.writeFile(path.join(args.out, "GUIDE.txt"), HELP + "\n\n" + ANNOTATION_PROMPT);
    console.log(JSON.stringify({ videos: summaries.length, tasks: count, out: args.out, network_calls: 0 }));
  } finally { db.close(); await output.close(); }
}

async function load(args: Options) {
  // Missing prepare.json indicates an interrupted preparation; never annotate a partial dataset.
  const manifest = JSON.parse(await fs.readFile(path.join(args.out, "prepare.json"), "utf8"));
  const tasks = (await jsonl(path.join(args.out, "tasks.jsonl"))).map(t => TaskSchema.parse(t));
  if (tasks.length !== manifest.tasks || new Set(tasks.map(t=>t.id)).size !== tasks.length) throw new Error("任务数量或唯一性与准备清单不一致");
  const records = new Map<string, LabelRecord>();
  for (const row of await optionalJsonl(path.join(args.out, "labels.jsonl"))) {
    const task = tasks.find(t => t.id === row.task_id);
    if (row.model === args.model && task && row.input_hash === taskHash(task)) {
      validateObservation(task, row.label); records.set(row.task_id, row);
    }
  }
  return { tasks, records: [...records.values()] };
}
async function run(args: Options) {
  if (!args.model) throw new Error("明确指定 --model，防止误用默认模型");
  const { tasks, records } = await load(args);
  const pending = tasks.filter(t => !records.some(r=>r.task_id===t.id));
  const selected = args.limit ? pending.slice(0,args.limit) : pending;
  console.log(JSON.stringify({ total: tasks.length, done: records.length, selected: selected.length, go: !!args.go }));
  const s = selected[0];
  if (!args.go) {
    console.log(ANNOTATION_PROMPT);
    if (s) console.log(JSON.stringify({ task: s, input_hash: taskHash(s) }, null, 2));
    return;
  }
  if (!args["base-url"] || !process.env.ANNOTATION_API_KEY) throw new Error("--go 需要 --base-url 和 ANNOTATION_API_KEY");
  const client = new OpenAI({ baseURL: args["base-url"], apiKey: process.env.ANNOTATION_API_KEY, maxRetries: 0, timeout: 180000 });
  let failures = 0;
  for (const task of selected) {
    try {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: "text", text: JSON.stringify(task) }];
      if (JSON.stringify(task).length > 60000) throw new Error("单任务文字过长，请重新分批，不自动截断");
      for (const img of task.images.filter(i=>i.sha256)) {
        const bytes = await fs.readFile(img.path);
        if (fileHash(bytes) !== img.sha256) throw new Error("图片已变化，请重新 prepare");
        content.push({ type: "text", text: `以下图片属于 source_id=${img.source_id}，path=${img.path}` },
          { type: "image_url", image_url: { url: `data:${mime(bytes)};base64,${bytes.toString("base64")}` } });
      }
      let correction = "", saved = false;
      for (let attempt=0; attempt<2; attempt++) {
        const response = await client.chat.completions.create({ model: args.model, temperature: 0,
          response_format: { type: "json_object" }, messages: [
            { role: "system", content: ANNOTATION_PROMPT }, { role: "user", content },
            ...(correction ? [{ role: "user" as const, content: `上次输出校验失败：${correction}。请根据原始材料重新输出完整 JSON。` }] : []),
          ] });
        // Record usage even for rejected responses, never log credentials or raw provider errors.
        await fs.appendFile(path.join(args.out, "usage.jsonl"), JSON.stringify({ task_id: task.id, attempt, model: args.model, usage: response.usage ?? null }) + "\n");
        try {
          const choice=response.choices[0];
          if (choice?.finish_reason !== "stop" || !choice.message.content) throw new Error("输出被截断/拒绝/为空");
          const label=validateObservation(task,JSON.parse(choice.message.content));
          await fs.appendFile(path.join(args.out,"labels.jsonl"),JSON.stringify({ task_id:task.id, input_hash:taskHash(task), model:args.model,
            version:ANNOTATION_VERSION, created_at:new Date().toISOString(), status:"teacher_pending_review", label, review_reasons:reviewReasons(label) })+"\n");
          saved=true;break;
        } catch(e) { correction=e instanceof Error ? e.message : "校验失败"; }
      }
      if(!saved)throw new Error("两次预标均未通过校验");
      console.log(`${task.id} 已预标，待人工复核`);
    } catch(e) {
      failures++;
      await fs.appendFile(path.join(args.out,"errors.jsonl"),JSON.stringify({task_id:task.id,input_hash:taskHash(task),
        error:e instanceof OpenAI.APIError ? `API status=${e.status ?? "unknown"}` : String(e), at:new Date().toISOString()})+"\n");
      console.error(`${task.id} 失败，未标记完成`);
    }
  }
  if(failures)process.exitCode=1;
}

async function review(args: Options, check: boolean) {
  if(!args.model)throw new Error("指定与预标一致的 --model");
  const {tasks,records}=await load(args);
  const dir=path.join(args.out,"reviews");await fs.mkdir(dir,{recursive:true});
  const accepted: unknown[]=[], errors: unknown[]=[];
  for(const bvid of new Set(tasks.map(t=>t.bvid))) {
    const selected=tasks.filter(t=>t.bvid===bvid), matching=records.filter(r=>selected.some(t=>t.id===r.task_id));
    const input_hash=fingerprint(matching.map(r=>({task_id:r.task_id,input_hash:r.input_hash,label:r.label})));
    const file=path.join(dir,`${bvid}.json`);
    if(check){
      try{accepted.push(validateReview(tasks,records,JSON.parse(await fs.readFile(file,"utf8"))));}
      catch(e){errors.push({bvid,error:String(e)});} continue;
    }
    const evidence=matching.flatMap(row=>row.label.evidence.map(e=>({ref:`${row.task_id}/${e.id}`,...e,
      sampled_at_s:e.cell===null ? null : selected.find(t=>t.id===row.task_id)?.sources.find(s=>s.id===e.source_id)?.cells.find(c=>c.index===e.cell)?.t,
    })));
    await fs.writeFile(path.join(dir,`${bvid}.evidence.json`),JSON.stringify({bvid,input_hash,pending_tasks:selected.filter(t=>!matching.some(r=>r.task_id===t.id)).map(t=>t.id),
      evidence,issues:matching.flatMap(r=>r.label.issues),tasks:selected},null,2));
    const template={bvid,input_hash,reviewer:"待填写",reviewed_at:new Date().toISOString(),verifications:[],decisions:["video","comments"].map(scope=>({scope,
      status:"insufficient_evidence",evidence_refs:[],reason:"待人工复核",basis:"none",reviewed_all_supplied:false,material_sufficient:false,limitations:["待人工检查原始材料并核对教师漏标"]}))};
    try{await fs.writeFile(file,JSON.stringify(template,null,2),{flag:"wx"});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  }
  if(check){
    await fs.writeFile(path.join(args.out,"adjudicated.jsonl"),accepted.map(r=>JSON.stringify(r)).join("\n")+(accepted.length?"\n":""));
    await fs.writeFile(path.join(args.out,"check.json"),JSON.stringify({accepted:accepted.length,errors},null,2));
    console.log(JSON.stringify({accepted:accepted.length,invalid:errors.length}));if(errors.length)process.exitCode=1;
  }else console.log(`复核模板与证据包已生成：${dir}。必须人工填写，check 后才生成结论。`);
}

if(import.meta.main){
  try{
    const args=options();
    if(args.help)console.log(HELP);
    else if(args.command==="prepare")await prepare(args);
    else if(args.command==="run")await run(args);
    else if(args.command==="review"||args.command==="check")await review(args,args.command==="check");
    else throw new Error(HELP);
  }catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}
}
