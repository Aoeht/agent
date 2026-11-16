import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { ANNOTATION_VERSION, taskHash, fingerprint, validateObservation, validateReview, reviewReasons,
  type AnnotationTask, type Observation, type Review } from "../src/bili/annotation";

const task: AnnotationTask = { version: ANNOTATION_VERSION, id: "BVtest#comments-1", bvid: "BVtest",
  sources: [{ id: "comment:1", kind: "comment", speaker: "commenter:9", text: "加我微信，保证月入三万", parent: "root", root: "root", start_s: null, end_s: null, cells: [] }], images: [], limitations: [] };
const item: Observation["evidence"][number] = { id: "e1", source_id: "comment:1", type: "contact", modality: "text", cell: null,
  quote: "加我微信", actor: "commenter", actor_ref: "commenter:9", context: "promotion", object: "接单项目", confidence: "high" };
const label: Observation = { evidence: [item, { ...item, id: "e2", type: "promise", quote: "保证月入三万" }], issues: [] };
const records = () => [{ task_id: task.id, input_hash: taskHash(task), model: "fake", label }];
function review(): Review {
  return { bvid: task.bvid, reviewer: "reviewer-1", reviewed_at: "2026-11-16T00:00:00Z",
    input_hash: fingerprint(records().map(r=>({task_id:r.task_id,input_hash:r.input_hash,label:r.label}))), verifications: [],
    decisions: [
      { scope: "video", status: "insufficient_evidence", evidence_refs: [], reason: "只有评论，无视频材料", basis: "none", reviewed_all_supplied: false, material_sufficient: false, limitations: ["缺视频"] },
      { scope: "comments", status: "suspected", evidence_refs: [`${task.id}/e1`,`${task.id}/e2`], reason: "收益承诺与通道关联，需核实项目", basis: "pending_verification", reviewed_all_supplied: true, material_sufficient: false, limitations: ["项目未核实"] },
    ] };
}

test("证据原文、归因、引用否定、图形与文本分别校验", () => {
  expect(validateObservation(task,label)).toEqual(label);
  for (const patch of [ { quote: "添加微信必赚" }, { actor: "author", actor_ref: "author" }, { source_id: "not-there" },
    { modality: "visual", cell: 1 }, { type: "qr", quote: null }, { actor: "third_party", actor_ref: "commenter:9" } ]) {
    expect(()=>validateObservation(task,{ evidence:[{...item,...patch}],issues:[] })).toThrow();
  }
  const warning = { ...item, context:"warning" as const,actor:"third_party" as const,actor_ref:null };
  expect(reviewReasons({evidence:[warning,{...warning,id:"e2",type:"promise"}],issues:[]})).toEqual([]);
  expect(reviewReasons(label)).toContain("同主体同对象的通道与营销话术共现候选");
  expect(reviewReasons({evidence:[item,{...label.evidence[1]!,object:"另一产品"}],issues:[]})).toEqual([]);
  expect(()=>validateObservation(task,{...label,risk_level:"high"})).toThrow();
});

test("拼图只接受实际存在的格位，二维码不编造内容", () => {
  const grid:AnnotationTask={...task,sources:[{...task.sources[0]!,id:"grid",kind:"segment",speaker:"author",cells:[{index:2,t:5}]}],images:[{source_id:"grid",path:"/grid.jpg",sha256:"hash"}]};
  const qr={...item,source_id:"grid",type:"qr",modality:"visual",cell:2,quote:null,actor:"author",actor_ref:"author"};
  expect(validateObservation(grid,{evidence:[qr],issues:[]}).evidence).toHaveLength(1);
  expect(()=>validateObservation(grid,{evidence:[{...qr,cell:3}],issues:[]})).toThrow();
  expect(()=>validateObservation(grid,{evidence:[{...qr,quote:"猜测解码"}],issues:[]})).toThrow();
});

test("候选门不能升级成支持结论；人工核验必须绑定正确主体的具体宣称", () => {
  expect(validateReview([task],records(),review()).decisions[1]!.status).toBe("suspected");
  const r=review();r.decisions[1]!.status="supported";r.decisions[1]!.material_sufficient=true;r.decisions[1]!.basis="verified_contradiction";
  expect(()=>validateReview([task],records(),r)).toThrow("已证伪");
  r.verifications=[{claim_ref:`${task.id}/e2`,state:"verified_false",reason:"人工查证项目所称授权不存在",supports:[]}];
  expect(()=>validateReview([task],records(),r)).toThrow("独立支持");
  r.verifications[0]!.supports=[{reference:"人工核实记录001",excerpt:"该机构回复未授权",checked_at:r.reviewed_at}];
  expect(validateReview([task],records(),r).decisions[1]!.status).toBe("supported");
  r.decisions[1]!.scope="video";
  expect(()=>validateReview([task],records(),r)).toThrow();
});

test("无法核验、未读完、旧版本、空白模板不能产生正常标签", () => {
  const r=review(), d=r.decisions[1]!;
  d.status="no_risk_observed";d.basis="none";
  expect(()=>validateReview([task],records(),r)).toThrow();
  d.material_sufficient=true;d.limitations=[];
  expect(validateReview([task],records(),r).decisions[1]!.status).toBe("no_risk_observed");
  r.verifications=[{claim_ref:`${task.id}/e2`,state:"unverifiable",reason:"页面不可达",supports:[]}];
  expect(()=>validateReview([task],records(),r)).toThrow("未解决");
  const fresh=review();fresh.reviewer="待填写";
  expect(()=>validateReview([task],records(),fresh)).toThrow("模板");
  expect(()=>validateReview([task],[],review())).toThrow("版本");
  expect(taskHash({...task,limitations:["changed"]})).not.toBe(taskHash(task));
});

test("未读取图片与缺失视频不能被勾选材料充分绕过", () => {
  const withMissing = {...task, images:[{source_id:"comment:1",path:"missing.jpg",sha256:null}]};
  const changedRecords=[{...records()[0]!,input_hash:taskHash(withMissing)}];
  const r=review();r.input_hash=fingerprint(changedRecords.map(row=>({task_id:row.task_id,input_hash:row.input_hash,label:row.label})));
  Object.assign(r.decisions[1]!,{status:"no_risk_observed",basis:"none",material_sufficient:true,limitations:[]});
  expect(()=>validateReview([withMissing],changedRecords,r)).toThrow("未读取图片");
  const metadata={...task,id:"BVtest#metadata",images:[],sources:[{...task.sources[0]!,kind:"metadata" as const,speaker:"author"}]};
  const empty={task_id:metadata.id,input_hash:taskHash(metadata),model:"fake",label:{evidence:[],issues:[]}};
  const noVideo=review();noVideo.input_hash=fingerprint([{task_id:empty.task_id,input_hash:empty.input_hash,label:empty.label}]);
  Object.assign(noVideo.decisions[0]!,{status:"no_risk_observed",basis:"none",reviewed_all_supplied:true,material_sufficient:true,limitations:[]});
  Object.assign(noVideo.decisions[1]!,{status:"insufficient_evidence",basis:"none",evidence_refs:[]});
  expect(()=>validateReview([metadata],[empty],noVideo)).toThrow("没有视频片段");
});

test("直接行为路径不要求收益话术，但普通通道不能冒充行为证据", () => {
  const r=review();Object.assign(r.decisions[1]!,{status:"supported",basis:"direct_behavior",material_sufficient:true});
  expect(()=>validateReview([task],records(),r)).toThrow("异常交易");
  const behaviorTask={...task,sources:[{...task.sources[0]!,text:"先交解冻费才能提现"}]};
  const transaction={evidence:[{...item,type:"transaction_anomaly" as const,quote:"先交解冻费才能提现"}],issues:[]};
  const rows=[{...records()[0]!,input_hash:taskHash(behaviorTask),label:transaction}];
  r.input_hash=fingerprint(rows.map(row=>({task_id:row.task_id,input_hash:row.input_hash,label:row.label})));
  r.decisions[1]!.evidence_refs=[`${task.id}/e1`];
  expect(validateReview([behaviorTask],rows,r).decisions[1]!.status).toBe("supported");
});

test("SQLite任务准备不泄露旧标签，保留深层评论和缺失图片，默认不联网", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"fraud-annotation-"));
  try{
    const file=path.join(dir,"data.sqlite"),db=new Database(file);
    db.exec(`CREATE TABLE videos(bv TEXT,title TEXT,introduction TEXT,owner_mid TEXT,availability TEXT,audit_label TEXT);
      INSERT INTO videos VALUES('BVtest','正常标题','正文','9',NULL,'SECRET_OLD_LABEL');
      CREATE TABLE authors(mid TEXT,signature TEXT);INSERT INTO authors VALUES('9','签名');
      CREATE TABLE comments(rpid TEXT,root_rpid TEXT,parent_rpid TEXT,mid TEXT,content TEXT,is_up INTEGER,is_pinned INTEGER,in_latest_full INTEGER,last_observed_at TEXT,last_snapshot_at TEXT,source TEXT,images_json TEXT);
      INSERT INTO comments VALUES('2','1','3','8','深层回复',0,0,1,NULL,NULL,'v4','[{"url":"https://example.invalid/x.jpg"}]');
      CREATE TABLE comment_stats(bv TEXT,source TEXT,reply_scope TEXT,main_end_reached INTEGER,exported_at TEXT);
      CREATE TABLE danmaku(bv TEXT,dmid TEXT,offset_seconds REAL,text TEXT);`);
    // Fixture comments table needs bv, just as the actual dataset.
    db.exec("ALTER TABLE comments ADD COLUMN bv TEXT;UPDATE comments SET bv='BVtest'");db.close();
    const segments=path.join(dir,"segments.jsonl"),out=path.join(dir,"out");await writeFile(segments,"");
    const run=async(args:string[])=>{const p=Bun.spawn([process.execPath,"run","benchmarks/annotate_fraud.ts",...args],{stdout:"pipe",stderr:"pipe"});const stdout=await new Response(p.stdout).text(),stderr=await new Response(p.stderr).text();return {code:await p.exited,stdout,stderr};};
    expect((await run(["prepare","--db",file,"--segments",segments,"--out",out])).code).toBe(0);
    const data=await readFile(path.join(out,"tasks.jsonl"),"utf8");
    expect(data).not.toContain("SECRET_OLD_LABEL");expect(data).toContain("深层回复");expect(data).toContain("缺少本地路径");
    expect(JSON.parse(data.trim().split("\n")[1]!).sources[0].parent).toBe("3");
    const dry=await run(["run","--out",out,"--model","fake"]);expect(dry.code).toBe(0);expect(dry.stdout).toContain('"go":false');
    expect((await run(["prepare","--db",file,"--segments",segments,"--out",out])).code).toBe(1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
