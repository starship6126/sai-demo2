import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {api} from './api.mjs';
import {groupConversationTopics} from './conversation-topics.mjs';
import {bridgeTexts,representativeInterests,validateBridgeTopics} from '../shared/conversation-topics.ts';
import {scoreGroup} from '../shared/grouping.ts';

const sql=new DatabaseSync(':memory:');
for(const file of fs.readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort()){
 if(file.startsWith('0001_'))sql.exec("ALTER TABLE profiles ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT ''; ALTER TABLE profiles ADD COLUMN instagram_visible TEXT NOT NULL DEFAULT 'private';");
 sql.exec(fs.readFileSync('drizzle/'+file,'utf8'));
}
const DB={prepare(query){const statement=sql.prepare(query);let args=[];return {bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return {results:statement.all(...args)};},async run(){return statement.run(...args);}};},async batch(statements){return Promise.all(statements.map(statement=>statement.run()));}};
let calls=0,prompt='',candidate,mode='valid',optimizedMatches=[];
const env={DB,GEMINI_API_KEY:'fixture-key',fetch:async(url,options)=>{
 calls++;prompt=JSON.parse(options.body).input;
 assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');
 return Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({candidates:mode==='none'?[]:[candidate]})}]}]});
},validateBridgeTopics:async(people,candidates,direct)=>validateBridgeTopics(people,candidates,bridgeTexts(people,candidates).map(()=>mode==='weak'?[0,1]:[1,0]).map((vector,index)=>mode==='weak'&&index===0?[1,0]:vector),direct),optimizeGroups:async(people,matches)=>{
 optimizedMatches=matches;const ids=people.map(person=>person.id),metrics=scoreGroup(people,matches,ids);
 return [{mode:'cohesion',groups:[{ids,score:metrics.utility,metrics,interests:matches}],unassigned:[],score:Math.round(metrics.utility*100),minScore:Math.round(metrics.utility*100),range:0,algorithm:'fixture'}];
}};
async function call(body,token='',query='',environment=env){
 if(body?.action==='saveProfile'&&body.version===undefined&&token)body={...body,version:(await call(undefined,token,'',environment)).data.me?.version??null};
 const response=await api(new Request('https://test.invalid/api/app'+query,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),environment);
 return {status:response.status,data:await response.json()};
}
const accounts=[];
for(const [index,label,category] of [[0,'アニメ Anime','콘텐츠'],[1,'Japan Travel','여행'],[2,'Photography','기타']]){
 const password='bridge-fixture-password-123';
 const registered=await call({action:'register',username:'bridge_'+index,password,confirmPassword:password});
 assert.equal(registered.status,200);
 const token=registered.data.token;
 const interests=[{id:'public-'+index,label,category,shared:true},{id:'private-'+index,label:'개인적인 비공개 항목 '+index,category:'기타',shared:false},{id:'avoid-'+index,label:'야구',category:'운동',shared:true,preference:'avoid'}];
 const saved=await call({action:'saveProfile',name:'참가자'+index,interests},token);
 assert.equal(saved.status,200);accounts.push({id:saved.data.id,token,interests});
}
for(const account of accounts.slice(1)){
 await call({action:'requestFriend',id:accounts[0].id},account.token);
 await call({action:'acceptFriend',id:account.id},accounts[0].token);
}
candidate={id:'bridge-pilgrimage',label:'애니메이션 성지순례 사진 여행',category:'여행',reason:'애니메이션 장소와 일본 여행, 사진 촬영을 함께 이야기할 수 있어요.',connections:accounts.map((account,index)=>({profile:account.id,interests:['public-'+index],reason:['애니메이션 장면 속 장소','일본 여행의 방문지','방문지 사진 촬영'][index]})),confidence:.99};
const request={action:'analyze',profileIds:accounts.map(account=>account.id),useBridge:true};
assert.equal((await call(request)).status,401);
assert.equal((await call({...request,profileIds:[accounts[0].id,'unrelated']},accounts[0].token)).status,403);
const recommendation=await call(request,accounts[0].token);
assert.equal(recommendation.status,200);assert.equal(recommendation.data.bridgeStatus,'complete');
assert.equal(recommendation.data.matches.length,1);assert.equal(recommendation.data.matches[0].kind,'bridge');
assert.equal(recommendation.data.matches[0].members.length,3);
assert(!prompt.includes('개인적인 비공개'));assert(!prompt.includes('야구'));assert(!prompt.includes('참가자0'));
assert(!JSON.stringify(recommendation.data.matches).includes('개인적인 비공개'));
const automatic=await call({action:'analyze',profileIds:request.profileIds},accounts[0].token);assert.equal(automatic.data.bridgeStatus,'complete','Bridge discovery is the default account path');const callsBeforeOptOut=calls,optOut=await call({...request,useBridge:false},accounts[0].token);assert.equal(optOut.data.bridgeStatus,undefined);assert.equal(calls,callsBeforeOptOut,'explicit opt-out never calls Gemini');
const originalCandidate=candidate;
candidate={...originalCandidate,connections:originalCandidate.connections.slice(1)};
assert.equal((await call(request,accounts[0].token)).data.bridgeStatus,'none');
candidate=originalCandidate;mode='weak';
assert.equal((await call(request,accounts[0].token)).data.matches.length,0);
mode='valid';
const noKey=await call(request,accounts[0].token,'',{...env,GEMINI_API_KEY:''});
assert.equal(noKey.status,200);assert.equal(noKey.data.bridgeStatus,'unavailable');
assert(noKey.data.bridgeMessage.includes('GEMINI_API_KEY'));
// Excluding the caller respects the exact selected group.
candidate={...originalCandidate,connections:originalCandidate.connections.slice(1)};
const withoutMe=await call({...request,profileIds:accounts.slice(1).map(account=>account.id)},accounts[0].token);
assert.deepEqual(withoutMe.data.people.map(person=>person.id),accounts.slice(1).map(account=>account.id));
assert.equal(withoutMe.data.matches[0].members.length,2);
candidate=originalCandidate;
const room=(await call({action:'createRoom',name:'연결 주제 모임'},accounts[0].token)).data.id;
for(const account of accounts.slice(1))await call({action:'joinRoom',id:room},account.token);
const optimized=await call({action:'optimizeGroups',room,selected:accounts.map(account=>account.id),size:3,useBridge:true},accounts[0].token);
assert.equal(optimized.status,200);assert.equal(optimized.data.bridgeTopics.length,1);
assert(optimizedMatches.some(match=>match.kind==='bridge'));
assert(optimized.data.plans[0].groups[0].metrics.topicStrength>0);
const plan={size:3,selected:accounts.map(account=>account.id),groups:[accounts.map(account=>account.id)],unassigned:[],bridgeTopics:optimized.data.bridgeTopics};
assert.equal((await call({action:'saveRoomPlan',room,plan},accounts[1].token)).status,403);
assert.equal((await call({action:'saveRoomPlan',room,plan},accounts[0].token)).status,200);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,1);
// A category change invalidates a saved semantic score even when id/label stay the same.
await call({action:'saveProfile',name:'참가자1',interests:accounts[1].interests.map(interest=>({...interest,category:'기타'}))},accounts[1].token);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,0);
await call({action:'saveProfile',name:'참가자1',interests:accounts[1].interests},accounts[1].token);
// Provider-imported public evidence participates in embeddings; changed text needs revalidation.
const sourceInterests=accounts[1].interests.map(interest=>({...interest,...(interest.shared&&interest.preference!=='avoid'?{source:{kind:'youtube',label:'공개 여행 영상',detail:'일본 여행의 방문지를 기록함',url:'https://www.youtube.com/watch?v=fixture'}}:{})}));
sql.prepare('UPDATE profiles SET interests=? WHERE id=?').run(JSON.stringify(sourceInterests),accounts[1].id);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,0);
assert.equal((await call({action:'saveRoomPlan',room,plan},accounts[0].token)).status,200);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,1);
sourceInterests[0].source.label='새로운 여행 영상 제목';
sql.prepare('UPDATE profiles SET interests=? WHERE id=?').run(JSON.stringify(sourceInterests),accounts[1].id);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,0);
assert.equal((await call({action:'saveRoomPlan',room,plan},accounts[0].token)).status,200);
sourceInterests[0].source.detail='항공편 일정과 숙소를 정리함';
sql.prepare('UPDATE profiles SET interests=? WHERE id=?').run(JSON.stringify(sourceInterests),accounts[1].id);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,0);
sql.prepare('UPDATE profiles SET interests=? WHERE id=?').run(JSON.stringify(accounts[1].interests),accounts[1].id);
assert.equal((await call({action:'saveRoomPlan',room,plan},accounts[0].token)).status,200);
// A room member outside the saved selection does not veto its table's bridge.
const extraAccounts=[];
for(const [index,label,category] of [[3,'Night Hiking','운동'],[4,'Night Sky Photography','기타'],[5,'Camping Food','음식']]){
 const password='bridge-fixture-password-123';
 const registered=await call({action:'register',username:'bridge_'+index,password,confirmPassword:password});
 const token=registered.data.token,interests=[{id:'public-'+index,label,category,shared:true},...(index===3?[{id:'avoid-bridge',label:originalCandidate.label,category:'여행',shared:true,preference:'avoid'}]:[])];
 const saved=await call({action:'saveProfile',name:'참가자'+index,interests},token);
 assert.equal(saved.status,200);extraAccounts.push({id:saved.data.id,token,interests});
 assert.equal((await call({action:'joinRoom',id:room},token)).status,200);
}
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,1);
const changed=accounts[1].interests.map(interest=>({...interest,shared:false}));
await call({action:'saveProfile',name:'참가자1',interests:changed},accounts[1].token);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,0);
assert.equal((await call({action:'saveRoomPlan',room,plan},accounts[0].token)).status,400);
for(const account of accounts.slice(0,2))await call({action:'saveProfile',name:'직접 근거 확인',interests:[...account.interests,{id:'jazz-'+account.id,label:'재즈',category:'음악',shared:true}]},account.token);
const directFallback=await call({...request,profileIds:accounts.slice(0,2).map(account=>account.id)},accounts[0].token,'',{...env,GEMINI_API_KEY:''});
assert.equal(directFallback.status,200);
assert.equal(directFallback.data.bridgeStatus,'unavailable');
assert(directFallback.data.matches.some(match=>match.kind==='exact'&&match.label==='재즈'));
for(const account of accounts)await call({action:'saveProfile',name:'참가자',interests:account.interests},account.token);
// Two disjoint tables need their own bridge; no candidate can connect all six.
const tables=[accounts,extraAccounts],scopes=[],optimizerInputs=[];
const multiEnv={...env,fetch:async(_url,options)=>{
 const profiles=JSON.parse(JSON.parse(options.body).input.split('PROFILES=')[1]);
 scopes.push(profiles.map(person=>person.id).sort());
 assert.equal(profiles.length,3);
 const first=profiles.some(person=>person.id===accounts[0].id);
 const topic={id:'b'.repeat(70),label:first?originalCandidate.label:'별빛 야영에서 산책과 야경 사진 촬영',category:first?'여행':'운동',reason:first?originalCandidate.reason:'야간 산책과 야경 촬영, 야영 음식을 함께 이야기할 수 있어요.',connections:profiles.map(person=>({profile:person.id,interests:[person.interests[0].id],reason:'공개 관심사에서 장소와 활동을 연결함'}))};
 return Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({candidates:[topic]})}]}]});
},optimizeGroups:async(people,matches)=>{
 optimizerInputs.push(matches);
 const groups=tables.map(table=>{const ids=table.map(person=>person.id),metrics=scoreGroup(people,matches,ids);return {ids,score:metrics.utility,metrics,interests:matches.filter(match=>ids.every(id=>match.members.includes(id)))};});
 return [{mode:'cohesion',groups,unassigned:[],score:70,minScore:70,range:0,algorithm:'fixture'}];
}};
const multi=await call({action:'optimizeGroups',room,selected:tables.flatMap(table=>table.map(account=>account.id)),size:3,useBridge:true},accounts[0].token,'',multiEnv);
assert.equal(multi.status,200);assert.equal(multi.data.bridgeStatus,'complete');assert.equal(multi.data.bridgeTopics.length,2);
assert.equal(scopes.length,2);assert.equal(optimizerInputs.length,2);
assert(optimizerInputs[0].every(match=>match.kind!=='bridge'));assert.equal(optimizerInputs[1].filter(match=>match.kind==='bridge').length,2);
assert.deepEqual(scopes.sort(),tables.map(table=>table.map(account=>account.id).sort()).sort());
assert.equal(new Set(multi.data.bridgeTopics.map(topic=>topic.id)).size,2);
assert(multi.data.bridgeTopics.every(topic=>topic.id.length<=80),'long valid Gemini IDs remain valid when table scopes are attached');
assert(multi.data.plans[0].groups.every(group=>group.metrics.topicStrength>0));
const multiPlan={size:3,selected:tables.flatMap(table=>table.map(account=>account.id)),groups:tables.map(table=>table.map(account=>account.id)),unassigned:[],bridgeTopics:multi.data.bridgeTopics};
assert.equal((await call({action:'saveRoomPlan',room,plan:multiPlan},accounts[0].token,'',multiEnv)).status,200);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,2);
const foreignDirect={id:'other-table-only',label:originalCandidate.label,category:'여행',kind:'exact',reason:'다른 테이블의 공통 주제',members:extraAccounts.map(account=>account.id),evidence:extraAccounts.map(account=>({profile:account.id,label:account.interests[0].label}))};
const scoped=await groupConversationTopics(tables.flat().map(account=>({id:account.id,name:'fixture',interests:account.interests})),[foreignDirect],multiEnv,3,multi.data.plans);
assert(scoped.bridgeTopics.some(topic=>topic.label===originalCandidate.label&&accounts.every(account=>topic.members.includes(account.id))),'a direct topic only on another table must not suppress this table bridge');
const weakSubsetPlan={size:3,selected:[...accounts.map(account=>account.id),extraAccounts[0].id],groups:[accounts.slice(0,2).map(account=>account.id),[accounts[2].id,extraAccounts[0].id]],unassigned:[],bridgeTopics:[multi.data.bridgeTopics.find(topic=>accounts.every(account=>topic.members.includes(account.id)))]};
const weakSubsetEnv={...env,validateBridgeTopics:async(people,candidates,direct)=>validateBridgeTopics(people,candidates,[...representativeInterests(people).flatMap(person=>person.interests.map(()=>accounts.slice(0,2).some(account=>account.id===person.id)?[.6,.8]:[1,0])),...candidates.map(()=>[1,0])],direct)};
assert.equal((await call({action:'saveRoomPlan',room,plan:weakSubsetPlan},accounts[0].token,'',weakSubsetEnv)).status,400,'global bridge harmonic consensus must not permit a weak final table subset');
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,2,'a rejected save preserves the prior plan');
let validationCalls=0,activeValidations=0,maxActive=0;
const labels=[['애니메이션 장면 속 일본 거리 산책','일본 배경 작품과 여행 사진 수집','도쿄 이야기 속 장소를 기록하는 여행'],['밤하늘 별자리와 야영 요리 촬영','숲길 캠핑에서 남기는 야경 사진','달빛 산책과 야영 간식 이야기']];
const batchPlan={...multiPlan,bridgeTopics:multi.data.bridgeTopics.flatMap((topic,table)=>labels[table].map((label,index)=>({...topic,id:`batch-${table}-${index}`,label})))};
const batchEnv={...env,validateBridgeTopics:async(people,candidates,direct,signal)=>{
 validationCalls++;activeValidations++;maxActive=Math.max(maxActive,activeValidations);
 assert.equal(candidates.length,3);assert(signal instanceof AbortSignal);
 await new Promise(resolve=>setTimeout(resolve,10));activeValidations--;
 return validateBridgeTopics(people,candidates,bridgeTexts(people,candidates).map(()=>[1,0]),direct);
}};
assert.equal((await call({action:'saveRoomPlan',room,plan:batchPlan},accounts[0].token,'',batchEnv)).status,200);
assert.equal(validationCalls,2);assert.equal(maxActive,2);
assert.equal((await call(undefined,accounts[0].token,'?room='+room)).data.selectedRoom.plan.bridgeTopics.length,6);
assert(calls>0);
console.log('PASS bridge API authorization, privacy, validation, direct fallback, per-table discovery/CP-SAT inputs and saved sharing/category/source invalidation');
