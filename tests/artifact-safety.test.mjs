import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";
const { createLogDirectory, createTaskDirectory, markTaskReady, setTaskProcess, cleanOldLogDirectories } = await loadModule("log-store.ts");
const { writeAtomic } = await loadModule("plugin-settings.ts");
const DAY=86400000;
function fixture(t) {
	const base=fs.mkdtempSync(path.join(os.tmpdir(),"artifact-safety-"));
	t.after(()=>fs.rmSync(base,{recursive:true,force:true})); return base;
}

test("runtime-marker initialization failure rolls back its unpublished directory",(t)=>{
	const base=fixture(t), original=fs.writeFileSync;
	try {
		fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(base+path.sep)&&path.basename(String(file)).startsWith("owner.json.tmp-"))throw new Error("metadata disk failure");return original(file,...args);};
		assert.throws(()=>createLogDirectory(base),/metadata disk failure/);
	} finally {fs.writeFileSync=original;}
	assert.deepEqual(fs.readdirSync(base),[]);
});

test("failed task initialization rolls back only the newly allocated task",(t)=>{
	const base=fixture(t), root=createLogDirectory(base), kept=createTaskDirectory(root,"keep1234"), original=fs.writeFileSync;
	fs.writeFileSync(kept.outputPath,"keep me");
	try {
		fs.writeFileSync=(file,...args)=>{if(String(file).startsWith(path.join(root.path,"fail1234")+path.sep)&&path.basename(String(file)).startsWith("task.json.tmp-"))throw new Error("task marker failed");return original(file,...args);};
		assert.throws(()=>createTaskDirectory(root,"fail1234"),/task marker failed/);
	} finally {fs.writeFileSync=original;}
	assert.equal(fs.existsSync(path.join(root.path,"fail1234")),false);
	assert.equal(fs.readFileSync(kept.outputPath,"utf8"),"keep me");
	assert.throws(()=>createTaskDirectory(root,"keep1234"),/EEXIST/);
	assert.equal(fs.readFileSync(kept.outputPath,"utf8"),"keep me");
});

test("GC never takes another OS user's directory even if its marker is recognizable",(t)=>{
	if(typeof process.getuid!=="function")return t.skip("POSIX uid not available");
	const base=fixture(t), root=createLogDirectory(base), now=Date.now(); root.close();
	const marker=path.join(root.path,"owner.json"), meta=JSON.parse(fs.readFileSync(marker,"utf8"));
	meta.createdAt=now-6*DAY;meta.closedAt=now-5*DAY;fs.writeFileSync(marker,JSON.stringify(meta));
	const date=new Date(now-5*DAY);fs.utimesSync(marker,date,date);fs.utimesSync(root.path,date,date);
	const original=fs.lstatSync;
	try {
		fs.lstatSync=(file,...args)=>{const stat=original(file,...args);return file===root.path?new Proxy(stat,{get:(target,key)=>key==="uid"?target.uid+1:Reflect.get(target,key)}):stat;};
		cleanOldLogDirectories(now,base,{policy:{retentionMs:DAY,budgetBytes:1}});
	} finally {fs.lstatSync=original;}
	assert.ok(fs.existsSync(root.path));
});

test("an explicitly configured tmp-base alias works without following discovered entry symlinks", (t) => {
	const base=fixture(t), aliases=fixture(t), alias=path.join(aliases,"tmp-alias"), victim=fixture(t);
	fs.symlinkSync(base,alias);
	const root=createLogDirectory(alias), task=createTaskDirectory(root,"alias123");
	fs.writeFileSync(task.outputPath,"old output"); markTaskReady(task,Date.now());
	fs.writeFileSync(path.join(victim,"keep"),"important");
	fs.symlinkSync(victim,path.join(base,"pi-cc-monitor-entry-link"));
	cleanOldLogDirectories(Date.now()+5*DAY,alias,{current:root});
	assert.equal(fs.existsSync(task.path),false);
	assert.ok(fs.existsSync(root.path));
	assert.equal(fs.readFileSync(path.join(victim,"keep"),"utf8"),"important");
	assert.ok(fs.lstatSync(path.join(base,"pi-cc-monitor-entry-link")).isSymbolicLink());
});

test("confirmed process cleanup clears the PID without pretending the terminal was delivered",(t)=>{
	const root=createLogDirectory(fixture(t)), task=createTaskDirectory(root,"pid12345");
	setTaskProcess(task,424242);setTaskProcess(task,null);
	const meta=JSON.parse(fs.readFileSync(path.join(task.path,"task.json"),"utf8"));
	assert.equal(meta.resourcePid,null);assert.equal(meta.readyAt,null);
});

test("atomic config rename failure retains the old data and removes temp file",(t)=>{
	const base=fixture(t), file=path.join(base,"settings.json"), original=fs.renameSync;
	fs.writeFileSync(file,"old settings");
	try {
		fs.renameSync=(from,to)=>{if(to===file)throw new Error("rename failed");return original(from,to);};
		assert.throws(()=>writeAtomic(file,"new settings"),/rename failed/);
	} finally {fs.renameSync=original;}
	assert.equal(fs.readFileSync(file,"utf8"),"old settings");assert.deepEqual(fs.readdirSync(base),["settings.json"]);
});

test("an atomic-config cleanup error after rename is nonfatal",(t)=>{
	const base=fixture(t), file=path.join(base,"settings.json"), original=fs.rmSync;
	try {
		fs.rmSync=(target,options)=>{if(path.basename(String(target)).startsWith("settings.json.tmp-"))throw new Error("cleanup failed");return original(target,options);};
		assert.doesNotThrow(()=>writeAtomic(file,"saved"));
	} finally {fs.rmSync=original;}
	assert.equal(fs.readFileSync(file,"utf8"),"saved");
	assert.deepEqual(fs.readdirSync(base),["settings.json"]);
});
