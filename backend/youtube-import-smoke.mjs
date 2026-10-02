import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {api} from './api.mjs';
import {TursoDatabaseError} from './turso-db.mjs';

const migrations=new URL('../drizzle/',import.meta.url);
const channels=Array.from({length:6},(_,index)=>({
 id:`channel-${index+1}`,
 title:index===0?'Jazz Sessions':`Channel ${index+1}`,
 description:index===0?'재즈 피아노 즉흥연주와 라이브 공연 영상':'구체적인 채널 설명',
 url:`https://www.youtube.com/channel/channel-${index+1}`,
}));

function database(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of fs.readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort()){
  if(file.startsWith('0001_'))sqlite.exec("ALTER TABLE profiles ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT ''; ALTER TABLE profiles ADD COLUMN instagram_visible TEXT NOT NULL DEFAULT 'private';");
  sqlite.exec(fs.readFileSync(new URL(file,migrations),'utf8').replaceAll('--> statement-breakpoint',''));
 }
 const DB={
  prepare(query){const statement=sqlite.prepare(query);let values=[];return {bind(...args){values=args;return this;},async first(){return statement.get(...values)||null;},async all(){return {results:statement.all(...values)};},async run(){return statement.run(...values);}};},
  async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},
 };
 return {sqlite,DB};
}

function seed({sqlite,DB},name='alice',sourceChannels=channels.slice(0,5)){
 const owner=`owner-${name}`,token=`token-${name}`,now=new Date().toISOString(),summary={itemCount:sourceChannels.length,candidateCount:0,counts:{subscriptions:sourceChannels.length},samples:sourceChannels.slice(0,3).map(row=>row.title),errors:[],channels:sourceChannels};
 sqlite.prepare('INSERT INTO accounts(owner,username,password_hash,created) VALUES(?,?,?,?)').run(owner,name,'fixture-hash',now);
 sqlite.prepare('INSERT INTO profiles(id,owner,name,bio,interests,color,created,instagram_handle,instagram_visible,linkedin_handle,linkedin_visible,avatar) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(`profile-${name}`,owner,name,'','[]','#3154F5',now,'','private','','private','');
 sqlite.prepare('INSERT INTO sessions(token_hash,owner,created) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),owner,now);
 sqlite.prepare("INSERT INTO source_syncs(owner,youtube_status,youtube_summary,youtube_updated,updated) VALUES(?,'ok',?,?,?)").run(owner,JSON.stringify(summary),now,now);
 return {owner,token,DB};
}

async function request(DB,token,body,signal){
 const response=await api(new Request('https://app.test/api/app',{method:body?'POST':'GET',signal,headers:{...(body?{'Content-Type':'application/json'}:{}),Authorization:`Bearer ${token}`},...(body?{body:JSON.stringify(body)}:{})}),{DB,...(body?.env||{})});
 return {status:response.status,data:await response.json()};
}

async function analyze(fixture,channelIds=['channel-1'],env={},signal){
 return request(fixture.DB,fixture.token,{action:'extractYouTubeInterests',channelIds,env},signal);
}

const geminiResult=interests=>Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({interests})}]}]});
const validInterest={label:'재즈 피아노 즉흥연주',category:'음악',refs:[1]};
const sameEmbeddings=async texts=>texts.map(()=>[1,0]);
const stored=(sqlite,owner)=>JSON.parse(sqlite.prepare('SELECT interests FROM profiles WHERE owner=?').get(owner).interests);
const state=(sqlite,owner)=>JSON.stringify({profile:sqlite.prepare('SELECT interests FROM profiles WHERE owner=?').get(owner),source:sqlite.prepare('SELECT youtube_summary FROM source_syncs WHERE owner=?').get(owner),topics:sqlite.prepare('SELECT id,canonical_key,label,category FROM interest_topics WHERE owner=? ORDER BY canonical_key').all(owner)});

const tests=[];
function test(name,run){tests.push({name,run});}

test('one selected channel creates a private keyword and a fresh GET returns it',async()=>{
 const store=database(),fixture=seed(store);
 const result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts:sameEmbeddings,fetch:async()=>geminiResult([validInterest])});
 assert.equal(result.status,200);assert.equal(result.data.count,1);assert.deepEqual(result.data.labels,[validInterest.label]);assert.equal(result.data.fallback,false);
 const imported=result.data.interests.find(row=>row.label===validInterest.label);assert.equal(imported.shared,false);assert.equal(imported.source.kind,'youtube');assert.equal(imported.source.url,channels[0].url);
 const fresh=await request(store.DB,fixture.token);assert(fresh.data.me.interests.some(row=>row.id===imported.id&&row.label===validInterest.label&&row.shared===false));
 assert.equal(stored(store.sqlite,fixture.owner).filter(row=>row.label===validInterest.label).length,1);
});

test('zero, six, duplicate, and unowned channel selections are rejected',async()=>{
 const store=database(),fixture=seed(store);let providers=0;const env={GEMINI_API_KEY:'fixture',embedInterestTexts:async()=>{providers++;return [];},fetch:async()=>{providers++;return geminiResult([validInterest]);}};
 for(const ids of [[],channels.map(row=>row.id),['channel-1','channel-1'],['not-owned']]){
  const result=await analyze(fixture,ids,env);assert.equal(result.status,400);
 }
 assert.equal(providers,0);assert.deepEqual(stored(store.sqlite,fixture.owner),[]);
});

test('Gemini and Qwen failures persist at least one grounded safe fallback',async()=>{
 const cases=[
  ['Gemini missing key',{embedInterestTexts:sameEmbeddings}],
  ['Gemini HTTP 500',{GEMINI_API_KEY:'fixture',embedInterestTexts:sameEmbeddings,fetch:async()=>new Response('failed',{status:500})}],
  ['Gemini malformed output',{GEMINI_API_KEY:'fixture',embedInterestTexts:sameEmbeddings,fetch:async()=>Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'not json'}]}]})}],
  ['Gemini empty output',{GEMINI_API_KEY:'fixture',embedInterestTexts:sameEmbeddings,fetch:async()=>geminiResult([])}],
  ['Qwen missing provider',{GEMINI_API_KEY:'fixture',fetch:async()=>{throw new Error('Gemini must not be called');}}],
  ['Qwen provider failure',{GEMINI_API_KEY:'fixture',embedInterestTexts:async()=>{throw new Error('qwen offline');},fetch:async()=>{throw new Error('Gemini must not be called');}}],
  ['Qwen zero vector',{GEMINI_API_KEY:'fixture',embedInterestTexts:async texts=>texts.map(()=>[0,0]),fetch:async()=>{throw new Error('Gemini must not be called');}}],
  ['Qwen NaN vector',{GEMINI_API_KEY:'fixture',embedInterestTexts:async texts=>texts.map(()=>[Number.NaN,1]),fetch:async()=>{throw new Error('Gemini must not be called');}}],
 ];
 for(const [name,env] of cases){
  const store=database(),fixture=seed(store,name.replaceAll(' ','-'));const result=await analyze(fixture,undefined,env);
  assert.equal(result.status,200,name);assert.equal(result.data.count,1,name);assert.equal(result.data.labels.length,1,name);assert.equal(result.data.labels[0],'Jazz Sessions 채널 시청',name);assert.equal(result.data.fallback,true,name);assert.equal(result.data.normalization.model,null,name);
  const imported=result.data.interests.find(row=>row.label==='Jazz Sessions 채널 시청');assert(imported,name);assert.equal(imported.shared,false,name);assert.equal(imported.source.kind,'youtube',name);assert.match(imported.source.detail,/Jazz Sessions/,name);assert.equal(imported.source.url,channels[0].url,name);
 }
});

test('sensitive-only channel metadata produces a generic fallback without sensitive text',async()=>{
 const store=database(),sensitive=[{id:'private-channel',title:'contact@example.com',description:'문의 010-1234-5678 https://secret.example',url:'https://www.youtube.com/channel/private-channel'}],fixture=seed(store,'sensitive',sensitive);
 const result=await analyze(fixture,['private-channel'],{});assert.equal(result.status,200);assert.deepEqual(result.data.labels,['선택한 구독 채널 시청']);assert.equal(result.data.fallback,true);
 const serialized=JSON.stringify(result.data.interests);assert(!serialized.includes('contact@example.com'));assert(!serialized.includes('010-1234-5678'));assert(!serialized.includes('secret.example'));
});

test('repeated fallback analysis returns count zero without duplicating or overwriting preference',async()=>{
 const store=database(),fixture=seed(store,'repeat');const first=await analyze(fixture);assert.equal(first.status,200);assert.equal(first.data.count,1);
 const rows=stored(store.sqlite,fixture.owner);rows[0].preference='explore';store.sqlite.prepare('UPDATE profiles SET interests=? WHERE owner=?').run(JSON.stringify(rows),fixture.owner);
 const second=await analyze(fixture);assert.equal(second.status,200);assert.equal(second.data.count,0);assert(second.data.labels.length>=1);const after=stored(store.sqlite,fixture.owner);assert.equal(after.length,1);assert.equal(after[0].preference,'explore');
});

test('Qwen semantic rejection falls back to the selected channel',async()=>{
 const store=database(),fixture=seed(store,'semantic');let calls=0;const embedInterestTexts=async texts=>{calls++;return texts.map(()=>calls===1?[1,0]:[0,1]);};
 const result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts,fetch:async()=>geminiResult([validInterest])});
 assert.equal(result.status,200);assert.equal(result.data.fallback,true);assert.deepEqual(result.data.labels,['Jazz Sessions 채널 시청']);assert(calls>=2);
});

test('a generated Qwen vector dimension mismatch uses original-channel fallback provenance',async()=>{
 const store=database(),fixture=seed(store,'dimension-mismatch');let calls=0;const embedInterestTexts=async texts=>{calls++;return texts.map(()=>calls===1?[1,0]:[1,0,0]);};
 const result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts,fetch:async()=>geminiResult([validInterest])});
 assert.equal(result.status,200);assert.equal(result.data.fallback,true);assert(result.data.labels.length>=1);assert.deepEqual(result.data.labels,['Jazz Sessions 채널 시청']);assert.equal(result.data.normalization.model,null);assert.equal(calls,2);
 const source=JSON.parse(store.sqlite.prepare('SELECT youtube_summary FROM source_syncs WHERE owner=?').get(fixture.owner).youtube_summary);assert.equal(source.inference.provider,'선택한 채널 원문');assert.equal(source.inference.fallback,true);
});

test('an unexpected catalog storage error is not converted into a model fallback',async()=>{
 const store=database(),fixture=seed(store,'catalog-error'),baseDB=store.DB,before=state(store.sqlite,fixture.owner);let embeddingCalls=0,geminiCalls=0;
 fixture.DB={prepare(query){const statement=baseDB.prepare(query);return {bind(...values){statement.bind(...values);return this;},first(){return statement.first();},async all(){if(query.startsWith('SELECT id,label,category FROM interest_topics'))throw new TursoDatabaseError('fixture storage read failed');return statement.all();},run(){return statement.run();}};},batch:baseDB.batch.bind(baseDB)};
 const result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts:async texts=>{embeddingCalls++;return texts.map(()=>[1,0]);},fetch:async()=>{geminiCalls++;return geminiResult([validInterest]);}});
 assert.equal(result.status,503);assert.equal(result.data.error,'처리하지 못했어요. 잠시 후 다시 시도해주세요.');assert.equal(embeddingCalls,0);assert.equal(geminiCalls,0);assert.equal(state(store.sqlite,fixture.owner),before);
});

test('the 60 second API model deadline falls back promptly and late provider completion cannot write',async()=>{
 const store=database(),fixture=seed(store,'deadline'),originalTimeout=AbortSignal.timeout;let embeddingCalls=0,geminiCalls=0,result,elapsed;
 AbortSignal.timeout=milliseconds=>originalTimeout(milliseconds===60000?15:milliseconds);
 try{
  const started=Date.now();result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts:async texts=>{embeddingCalls++;await new Promise(resolve=>setTimeout(resolve,50));return texts.map(()=>[1,0]);},fetch:async()=>{geminiCalls++;return geminiResult([validInterest]);}});elapsed=Date.now()-started;
 }finally{AbortSignal.timeout=originalTimeout;}
 assert.equal(result.status,200);assert.equal(result.data.fallback,true);assert.deepEqual(result.data.labels,['Jazz Sessions 채널 시청']);assert(elapsed<1000);assert.equal(embeddingCalls,1);assert.equal(geminiCalls,0);
 const afterResponse=state(store.sqlite,fixture.owner);await new Promise(resolve=>setTimeout(resolve,75));assert.equal(state(store.sqlite,fixture.owner),afterResponse);assert.equal(stored(store.sqlite,fixture.owner).length,1);
});

test('a YouTube source race cannot write stale interests or topics',async()=>{
 const store=database(),fixture=seed(store,'source-race'),beforeProfile=store.sqlite.prepare('SELECT interests FROM profiles WHERE owner=?').get(fixture.owner).interests;
 const result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts:sameEmbeddings,fetch:async()=>{
  const row=store.sqlite.prepare('SELECT youtube_summary FROM source_syncs WHERE owner=?').get(fixture.owner),summary=JSON.parse(row.youtube_summary);summary.channels[0].description='새로 연결된 원문';store.sqlite.prepare('UPDATE source_syncs SET youtube_summary=? WHERE owner=?').run(JSON.stringify(summary),fixture.owner);return geminiResult([validInterest]);
 }});
 assert.equal(result.status,409);assert.equal(store.sqlite.prepare('SELECT interests FROM profiles WHERE owner=?').get(fixture.owner).interests,beforeProfile);assert.equal(store.sqlite.prepare('SELECT COUNT(*) count FROM interest_topics WHERE owner=?').get(fixture.owner).count,0);assert.equal(JSON.parse(store.sqlite.prepare('SELECT youtube_summary FROM source_syncs WHERE owner=?').get(fixture.owner).youtube_summary).inference,undefined);
});

test('an aborted analysis does not write profile, source, or topic state',async()=>{
 const store=database(),fixture=seed(store,'abort'),before=state(store.sqlite,fixture.owner),controller=new AbortController();
 const result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts:async texts=>{controller.abort(new DOMException('fixture abort','AbortError'));return texts.map(()=>[1,0]);},fetch:async()=>geminiResult([validInterest])},controller.signal);
 assert.equal(result.status,503);assert.equal(state(store.sqlite,fixture.owner),before);
});

test('a profile CAS loss preserves the winning edit and writes no source inference or topics',async()=>{
 const store=database(),fixture=seed(store,'cas'),baseDB=store.DB;let inject=true;
 const raceDB={prepare(query){const statement=baseDB.prepare(query);return {bind(...values){statement.bind(...values);return this;},first(){return statement.first();},all(){return statement.all();},async run(){if(inject&&query.startsWith('UPDATE profiles SET interests=? WHERE owner=? AND interests=?')){inject=false;store.sqlite.prepare('UPDATE profiles SET interests=? WHERE owner=?').run(JSON.stringify([{id:'winner',label:'동시 저장',category:'기타',shared:false,preference:'explore'}]),fixture.owner);}return statement.run();}};},batch:baseDB.batch.bind(baseDB)};fixture.DB=raceDB;
 const result=await analyze(fixture,undefined,{GEMINI_API_KEY:'fixture',embedInterestTexts:sameEmbeddings,fetch:async()=>geminiResult([validInterest])});assert.equal(result.status,409);
 const after=stored(store.sqlite,fixture.owner);assert.deepEqual(after.map(row=>row.id),['winner']);assert.equal(store.sqlite.prepare('SELECT COUNT(*) count FROM interest_topics WHERE owner=?').get(fixture.owner).count,0);assert.equal(JSON.parse(store.sqlite.prepare('SELECT youtube_summary FROM source_syncs WHERE owner=?').get(fixture.owner).youtube_summary).inference,undefined);
});

test('topic capacity errors still reject without changing persisted state',async()=>{
 const store=database(),fixture=seed(store,'capacity'),insert=store.sqlite.prepare('INSERT INTO interest_topics(id,owner,canonical_key,label,category,created) VALUES(?,?,?,?,?,?)');
 for(let index=0;index<200;index++)insert.run(`topic-${index}`,fixture.owner,`기타:topic${index}`,`Topic ${index}`,'기타',new Date().toISOString());
 const before=state(store.sqlite,fixture.owner),result=await analyze(fixture);assert.equal(result.status,400);assert.match(result.data.error,/200개/);assert.equal(state(store.sqlite,fixture.owner),before);
});

let passed=0;
for(const {name,run} of tests){await run();passed++;console.log(`PASS ${name}`);}
console.log(`PASS YouTube import regression suite: ${passed} behaviors`);
