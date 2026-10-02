import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {api} from './api.mjs';

const sqlite=new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys=ON');
for(const file of fs.readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort()){
 if(file.startsWith('0001_'))sqlite.exec("ALTER TABLE profiles ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT ''; ALTER TABLE profiles ADD COLUMN instagram_visible TEXT NOT NULL DEFAULT 'private';");
 sqlite.exec(fs.readFileSync('drizzle/'+file,'utf8'));
}
const DB={
 prepare(query){const statement=sqlite.prepare(query);let args=[];return {bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return {results:statement.all(...args)};},async run(){return statement.run(...args);}};},
 async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},
};
async function call(body,token,env={},query=''){
 const response=await api(new Request('https://test.invalid/api/app'+query,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),{DB,...env});
 return {status:response.status,data:await response.json()};
}
async function register(username){const password='profile-conflict-password';const result=await call({action:'register',username,password,confirmPassword:password});assert.equal(result.status,200);return result.data.token;}
const token=await register('profile_owner');
const initial=await call({action:'saveProfile',version:null,name:'프로필 검증',bio:'처음 소개',interests:[{id:'jazz',label:'재즈',category:'음악',shared:true}]},token);
assert.equal(initial.status,200);
const old=(await call(undefined,token)).data.me;
assert.match(old.version,/^[a-f0-9]{64}$/,'own profile carries a content version');
assert.equal(initial.data.version,old.version);
assert.equal((await call(undefined,token)).data.me.version,old.version,'reading does not change the version');
assert.equal((await call(undefined,'',{},'?profile='+old.id)).data.profile.version,undefined,'private content versions are not exposed publicly');
assert.equal((await call(undefined,token,{},'?profile='+old.id)).data.profile.version,old.version);

const updated=await call({action:'saveProfile',...old,bio:'최신 소개'},token);
assert.equal(updated.status,200);
assert.notEqual(updated.data.version,old.version,'metadata edits invalidate old drafts too');
const latest=(await call(undefined,token)).data.me;
assert.equal(latest.version,updated.data.version);
assert.equal((await call({action:'saveProfile',...old,bio:'오래된 소개'},token)).status,409);
assert.equal((await call({action:'saveProfile',name:'버전 없는 저장',interests:[]},token)).status,409,'old clients cannot bypass conflict protection');
assert.equal((await call(undefined,token)).data.me.bio,'최신 소개');

const beforeImport=(await call(undefined,token)).data.me;
const imported=await call({action:'importLinkedInText',text:'Skills:\nPython'},token,{
 embedInterestTexts:async texts=>texts.map(text=>text.includes('Python')?[1,0]:[0,1]),
 GEMINI_API_KEY:'fixture-only',
 fetch:async()=>Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({interests:[{label:'Python',category:'공부·일',refs:['linkedin-0']}]})}]}]}),
});
assert.equal(imported.status,200);assert.equal(imported.data.count,1);
const afterImport=(await call(undefined,token)).data.me;
assert.notEqual(afterImport.version,beforeImport.version,'source imports automatically invalidate the profile version');
const python=afterImport.interests.find(interest=>interest.label==='Python');
assert(python?.source&&python.topicId);
const catalogBefore=sqlite.prepare('SELECT * FROM interest_topics ORDER BY id').all();
assert.equal((await call({action:'saveProfile',...beforeImport,bio:'수정 중인 소개'},token)).status,409);
assert.deepEqual((await call(undefined,token)).data.me,afterImport,'stale drafts cannot remove imported interests or provenance');
assert.deepEqual(sqlite.prepare('SELECT * FROM interest_topics ORDER BY id').all(),catalogBefore,'rejected saves cannot prune the new catalog');

const fresh=(await call(undefined,token)).data.me;
let injected=false;
const racingDB={...DB,prepare(query){
 const statement=DB.prepare(query);let args=[];
 return {bind(...values){args=values;statement.bind(...values);return this;},first:()=>statement.first(),all:()=>statement.all(),async run(){
  if(!injected&&query.startsWith('UPDATE profiles SET ')){
   injected=true;
   const interests=[...fresh.interests,{id:'race-interest',label:'새 프로젝트',category:'공부·일',shared:false,topicId:'race-topic',source:{kind:'linkedin',label:'새 프로젝트',detail:'동시 가져오기 근거'}}];
   sqlite.prepare('UPDATE profiles SET interests=? WHERE id=?').run(JSON.stringify(interests),fresh.id);
   const owner=sqlite.prepare('SELECT owner FROM profiles WHERE id=?').get(fresh.id).owner;
   sqlite.prepare('INSERT INTO interest_topics VALUES(?,?,?,?,?,?)').run('race-topic',owner,'공부·일:새프로젝트','새 프로젝트','공부·일','now');
  }
  return statement.run();
 }};
}};
const raced=await call({action:'saveProfile',...fresh,bio:'충돌 직전 소개'},token,{DB:racingDB});
assert(injected,'the race happens after version validation, immediately before the write');
assert.equal(raced.status,409,'atomic snapshot guard rejects changes after validation');
const raceWinner=(await call(undefined,token)).data.me;
assert(raceWinner.interests.some(interest=>interest.id==='race-interest'));
assert.equal(raceWinner.bio,fresh.bio);
assert(sqlite.prepare("SELECT id FROM interest_topics WHERE id='race-topic'").get(),'losing transaction leaves the winning catalog intact');

const secondToken=await register('profile_creation');
let creationInjected=false;
const creationDB={...DB,async batch(statements){
 if(!creationInjected){
  creationInjected=true;
  const owner=sqlite.prepare("SELECT owner FROM accounts WHERE username='profile_creation'").get().owner;
  sqlite.prepare('INSERT INTO profiles(id,owner,name,bio,interests,color,created) VALUES(?,?,?,?,?,?,?)').run('winning-profile',owner,'먼저 만든 프로필','승자 소개','[]','#000','now');
 }
 return DB.batch(statements);
}};
assert.equal((await call({action:'saveProfile',version:null,name:'뒤늦은 프로필',interests:[]},secondToken,{DB:creationDB})).status,409,'concurrent initial creation never overwrites an existing profile');
assert.equal((await call(undefined,secondToken)).data.me.name,'먼저 만든 프로필');

await call({action:'deleteProfile'},token);
assert.equal((await call({action:'saveProfile',...raceWinner},token)).status,409,'deleted profiles cannot be resurrected from an old editor');
assert.equal((await call(undefined,token)).data.me,null);
sqlite.close();
console.log('PASS profile versions, metadata/import conflicts, no-version rejection, atomic write races, catalog preservation, initial creation races, and deleted-profile conflicts');
