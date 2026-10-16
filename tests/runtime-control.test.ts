import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { RunControl } from '../src/lib/run-control';
import { prepareTaskRuntime } from '../src/lib/runtime-control';
import { admitFollowup } from '../src/lib/run-store';

let db: Database.Database;
const key='agent:test:clawtask:t';
beforeEach(()=>{
 db=new Database(':memory:');db.exec(fs.readFileSync('src/db/schema.sql','utf8'));
 db.prepare("INSERT INTO agents(id,openclawAgentId,displayName,apiKeyHash) VALUES('a','test','Test','unused')").run();
 db.prepare("INSERT INTO tasks(id,issueId,title,status,assigneeId,assigneeType) VALUES('t','TEST-001','Test','todo','a','agent')").run();
});
afterEach(()=>db.close());
function fixture(initial=true){
 const calls:any[]=[];let session:any=initial?null:{key,sessionId:'original',lifecycleRevision:'r1',archived:false,hasActiveRun:false,modelProvider:'old',model:'previous',modelOverrideSource:'user',thinkingLevel:'low',thinkingDefault:'medium',agentRuntime:{id:'openclaw'}};
 let hook:((method:string,p:any)=>any)|undefined;let available=true;
 const narrow=async(method:string,p:any)=>{
  calls.push({method,p,narrow:true});const result=await hook?.(method,p);if(result!==undefined)return result;
  if(method==='sessions.create'){assert.equal(session,null);assert.equal(p.message,undefined);assert.equal(p.task,undefined);session={key,sessionId:'created',lifecycleRevision:'r1',archived:false,hasActiveRun:false};return {ok:true,key,sessionId:session.sessionId,runStarted:false};}
  if(method==='sessions.describe')return {session:session?{...session}:null};
  if(method==='sessions.patch'){
   assert.equal(p.expectedSessionId,session.sessionId);assert.equal(p.expectedLifecycleRevision,session.lifecycleRevision);
   session={...session,modelProvider:p.model?.split('/')[0]??'default',model:p.model?.slice(p.model.indexOf('/')+1)??'agent-model',modelOverrideSource:p.model===null?null:'user',thinkingLevel:p.thinkingLevel??undefined,thinkingDefault:'medium',agentRuntime:{id:'openclaw'}};
   return {ok:true,key,entry:{sessionId:session.sessionId,modelOverrideSource:p.model===null?'default':'user',thinkingLevel:session.thinkingLevel},resolved:{modelProvider:session.modelProvider,model:session.model,agentRuntime:session.agentRuntime,thinkingLevel:session.thinkingLevel??'medium',thinkingLevels:[{id:'high'},{id:'medium'}]}};
  }
  throw Error(method);
 };
 const conn:any={agentId:'a',openclawAgentId:'test',currentTaskId:null,currentRunId:null};
 const admin=async(_:any,method:string,p:any)=>{
  calls.push({method,p,narrow:false});
  if(method==='sessions.describe')return {session:session?{...session}:null};
  if(method==='agent'){assert.ok(calls.some(c=>c.narrow&&c.method==='sessions.patch'));assert.equal(p.expectedExistingSessionId,session.sessionId);return {runId:p.idempotencyKey};}
  if(method==='agent.wait')return {runId:p.runId,status:'timeout'};
  throw Error(method);
 };
 const make=()=>new RunControl(db,admin,()=>available,()=> 'synthetic',()=>{},(_conn,row,s,settings)=>prepareTaskRuntime(narrow,{sessionKey:row.sessionKey,agentId:'test',dispatchId:row.id,session:s},settings));
 return {conn,calls,control:make(),make,narrow,get session(){return session;},setSession:(s:any)=>{session=s;},setHook:(fn:typeof hook)=>{hook=fn;},setAvailable:(value:boolean)=>{available=value;}};
}
const sends=(f:ReturnType<typeof fixture>)=>f.calls.filter(c=>c.method==='agent');
const row=()=>db.prepare('SELECT * FROM task_dispatches ORDER BY seq DESC LIMIT 1').get() as any;
for(const settings of [{modelOverride:null,thinkingOverride:null},{modelOverride:'test/model',thinkingOverride:null},{modelOverride:null,thinkingOverride:'high'},{modelOverride:'test/model',thinkingOverride:'high'}]) {
 for(const existing of [false,true])test('preflight before first submission '+JSON.stringify(settings)+' existing='+existing,async()=>{
  db.prepare('UPDATE tasks SET modelOverride=?,thinkingOverride=?').run(settings.modelOverride,settings.thinkingOverride);
  const f=fixture(!existing);await f.control.pump(f.conn);assert.equal(sends(f).length,1);
  const ordered=f.calls.map(c=>c.method);const sendIndex=ordered.indexOf('agent');assert.ok(ordered.lastIndexOf('sessions.patch',sendIndex)<sendIndex);
  assert.equal(f.calls[sendIndex-1].method,'sessions.describe');assert.equal(f.calls[sendIndex-1].narrow,true);
  assert.equal(f.calls.filter(c=>c.method==='sessions.create').length,existing?0:1);
  assert.deepEqual(JSON.parse(row().runtimeSettings),settings);assert.equal(row().runtimeSessionRevision,'r1');
  assert.equal(sends(f)[0].p.expectedExistingSessionLifecycleRevision,'r1');
 });
}
for(const mode of ['reject','wrong-model','wrong-thinking','wrong-identity','active-readback','default-provenance','missing-thinking','missing-resolved','missing-provenance','conflicting-activity','unknown-activity','wrong-key'])test('failed '+mode+' preflight retains pending identity, starts no model work',async()=>{
 const f=fixture(false);const original={...f.session};let patched=false;
 f.setHook((method,p)=>{
  if(method==='sessions.patch'){
   if(mode==='reject')throw Error('not allowed');
   patched=true;
   if(mode==='missing-resolved')return {ok:true,key,entry:{sessionId:'original'}};
   if(mode==='wrong-model')return {ok:true,key,entry:{sessionId:'original',modelOverrideSource:'default'},resolved:{modelProvider:'wrong',model:'model',agentRuntime:{id:'openclaw'},thinkingLevel:'medium'}};
  }
  if(method==='sessions.describe'&&patched){
   const s={...f.session};
   if(mode==='wrong-thinking')s.thinkingLevel='low';
   if(mode==='wrong-identity')s.sessionId='replacement';
   if(mode==='active-readback')s.hasActiveRun=true;
   if(mode==='conflicting-activity')s.status='running';
   if(mode==='unknown-activity')s.status='future';
   if(mode==='wrong-key')s.key='agent:test:unrelated';
   if(mode==='default-provenance')s.modelOverrideSource='user';
   if(mode==='missing-thinking'){delete s.thinkingLevel;delete s.thinkingDefault;}
   if(mode==='missing-provenance')delete s.modelOverrideSource;
   return {session:s};
  }
 });
 if(mode==='wrong-model')db.prepare("UPDATE tasks SET modelOverride='test/model'").run();
 await f.control.pump(f.conn);assert.equal(sends(f).length,0);assert.equal(row().state,'pending');assert.equal(row().runId,null);assert.equal(row().attempts,0);assert.equal(row().errorCode,'runtime_preparation_failed');
 assert.equal((db.prepare('SELECT * FROM task_sessions').get() as any).sessionId,original.sessionId);
});
test('unsupported thinking fails before submission rather than downgrading',async()=>{
 db.prepare("UPDATE tasks SET thinkingOverride='ultra'").run();const f=fixture();await f.control.pump(f.conn);assert.equal(sends(f).length,0);assert.equal(row().state,'pending');
});
test('failed patch retries preparation with same pending dispatch and submits only once',async()=>{
 const f=fixture(false);f.setHook(method=>{if(method==='sessions.patch')throw Error('unavailable');});await f.control.pump(f.conn);const id=row().id;
 f.setHook(undefined);await f.control.pump(f.conn);await f.control.pump(f.conn);assert.equal(row().id,id);assert.equal(sends(f).length,1);
});
test('settings changed during preparation invalidate snapshot then retry current settings',async()=>{
 const f=fixture(false);let changed=false;f.setHook(method=>{if(method==='sessions.patch'&&!changed){changed=true;db.prepare("UPDATE tasks SET modelOverride='test/changed',runtimeRevision=runtimeRevision+1").run();}});
 await f.control.pump(f.conn);assert.equal(sends(f).length,0);assert.equal(row().state,'pending');
 await f.control.pump(f.conn);assert.equal(sends(f).length,1);assert.equal(JSON.parse(row().runtimeSettings).modelOverride,'test/changed');
});
for(const mutate of ["status='blocked',assigneeId=NULL,assigneeType=NULL","assigneeId=NULL,assigneeType=NULL"])test('assignment/status change during runtime preparation prevents submit: '+mutate,async()=>{
 const f=fixture(false);f.setHook(method=>{if(method==='sessions.patch')db.prepare('UPDATE tasks SET '+mutate).run();});await f.control.pump(f.conn);assert.equal(sends(f).length,0);assert.equal(row().state,'pending');
});
test('reconnect owned attempt never reapplies settings or resubmits after settings edit',async()=>{
 const f=fixture();await f.control.pump(f.conn);const count=f.calls.filter(c=>c.narrow).length;const before=row();
 db.prepare("UPDATE tasks SET modelOverride='test/later',runtimeRevision=runtimeRevision+1").run();await f.make().pump(f.conn);
 assert.equal(f.calls.filter(c=>c.narrow).length,count);assert.equal(sends(f).length,1);assert.equal(row().id,before.id);assert.equal(row().runtimeSettings,before.runtimeSettings);
});
test('followup clears earlier overrides on original session and uses next-dispatch defaults',async()=>{
 const f=fixture(false);db.prepare("INSERT INTO task_sessions(taskId,agentId,sessionKey,sessionId) VALUES('t','a',?,'original')").run(key);
 db.prepare("INSERT INTO task_dispatches(id,taskId,agentId,sessionKey,state) VALUES('old','t','a',?,'completed')").run(key);
 db.prepare("INSERT INTO comments(id,taskId,authorId,authorType,content) VALUES('c','t','h','human','followup')").run();admitFollowup(db,db.prepare('SELECT * FROM tasks').get(),{id:'c',content:'followup'});
 await f.control.pump(f.conn);assert.equal(sends(f).length,1);assert.equal(sends(f)[0].p.expectedExistingSessionId,'original');assert.equal(f.session.modelOverrideSource,null);assert.equal(f.session.thinkingLevel,undefined);
});
test('missing original followup never creates replacement session',async()=>{
 const f=fixture();db.prepare("INSERT INTO task_sessions(taskId,agentId,sessionKey,sessionId) VALUES('t','a',?,'original')").run(key);await f.control.pump(f.conn);assert.equal(sends(f).length,0);assert.equal(f.calls.filter(c=>c.method==='sessions.create').length,0);
});
for(const acknowledgment of [{ok:true,key,sessionId:'created',runStarted:true},{ok:true,key,sessionId:'created'},{ok:false,key,sessionId:'created',runStarted:false}])test('unverified no-execution creation cannot reach patch or submit: '+JSON.stringify(acknowledgment),async()=>{
 const f=fixture();f.setHook(method=>method==='sessions.create'?acknowledgment:undefined);
 await f.control.pump(f.conn);assert.equal(sends(f).length,0);assert.equal(f.calls.filter(c=>c.method==='sessions.patch').length,0);assert.equal(row().state,'pending');
});
test('no configured runtime preparation callback cannot accidentally bypass enforcement',async()=>{
 const control=new RunControl(db,async()=>({session:{sessionId:'original',archived:false,hasActiveRun:false}}),()=>true,()=> 'synthetic');
 await control.pump({agentId:'a',openclawAgentId:'test',currentTaskId:null,currentRunId:null});assert.equal(row().state,'pending');assert.equal(row().errorCode,'runtime_preparation_failed');
});
