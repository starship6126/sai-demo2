import {ensureProfileColumns} from './profile-migration.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {api} from './api.mjs';
import {findMatches,normalizeInstagram,normalizeLinkedIn} from '../shared/matching.ts';
import {embeddingTexts,rankSemantic} from '../shared/semantic-ranking.ts';
const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
for(const name of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort()){if(name.startsWith('0001_'))sqlite.exec("ALTER TABLE profiles ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT ''; ALTER TABLE profiles ADD COLUMN instagram_visible TEXT NOT NULL DEFAULT 'private';");sqlite.exec(fs.readFileSync('drizzle/'+name,'utf8'));}
const DB={prepare(sql){let args=[];const stmt=sqlite.prepare(sql);return {bind(...v){args=v;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return stmt.run(...args);}};},async batch(stmts){return Promise.all(stmts.map(s=>s.run()));}};
async function call(body,token='',q=''){
 if(body?.action==='saveProfile'&&body.version===undefined&&token)body={...body,version:(await call(undefined,token)).data.me?.version??null};const result=await api(new Request('https://test.invalid/api/app'+q,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),{DB});return {status:result.status,data:await result.json()};}
const make=async username=>(await call({action:'register',username,password:'test-password-123',confirmPassword:'test-password-123'})).data.token;
const a=await make('user_a'),b=await make('user_b'),c=await make('user_c');
const liked={id:'like',label:'재즈',category:'음악',shared:true,preference:'like'},avoid={id:'avoid',label:'공포영화',category:'콘텐츠',shared:true,preference:'avoid'},explore={id:'explore',label:'도예',category:'기타',shared:true,preference:'explore'};
const saveA={action:'saveProfile',name:'가',interests:[liked,avoid,explore],instagramHandle:'https://www.instagram.com/Example_User/',instagramVisible:true};
const aid=(await call(saveA,a)).data.id,bid=(await call({action:'saveProfile',name:'나',interests:[liked,avoid,explore]},b)).data.id;
const cid=(await call({action:'saveProfile',name:'다',interests:[]},c)).data.id;
assert.equal((await call(undefined,a)).data.me.instagramHandle,'example_user');
assert.equal((await call(undefined,'','?profile='+aid)).data.profile.instagramHandle,undefined);
assert.equal((await call(undefined,c,'?profile='+aid)).data.profile.instagramHandle,undefined);
await call({action:'requestFriend',id:aid},b);
assert.equal((await call(undefined,b,'?profile='+aid)).data.profile.instagramHandle,undefined);
await call({action:'acceptFriend',id:bid},a);
assert.equal((await call(undefined,b,'?profile='+aid)).data.profile.instagramHandle,'example_user');
assert.equal((await call(undefined,b)).data.friends.find(p=>p.id===aid).instagramHandle,'example_user');
const room=(await call({action:'createRoom',name:'테스트 모임'},a)).data.id;
await call({action:'joinRoom',id:room},c);
assert((await call(undefined,c,'?room='+room)).data.selectedRoom.members.every(p=>p.instagramHandle===undefined));
await call({...saveA,instagramVisible:false},a);
assert.equal((await call(undefined,b,'?profile='+aid)).data.profile.instagramHandle,undefined);
await call(saveA,a);await call({action:'removeFriend',id:bid},a);
assert.equal((await call(undefined,b,'?profile='+aid)).data.profile.instagramHandle,undefined);
assert.equal((await call({...saveA,instagramHandle:'https://evil.invalid/example'},a)).status,400);
assert.equal((await call({...saveA,interests:[liked,{...liked,id:'opposite',preference:'avoid'}]},a)).status,400);
const result=await call({action:'analyze',profile:bid},a);
assert.equal(result.status,200);assert(result.data.matches.some(m=>m.label==='재즈'));assert(result.data.matches.some(m=>m.label==='도예'));assert(!result.data.matches.some(m=>m.label==='공포영화'));
assert.equal((await call(undefined,a)).data.me.interests.find(t=>t.id==='avoid').preference,'avoid');
const people=[{id:'a',interests:[liked,avoid]},{id:'b',interests:[{...liked,label:'재즈 공연'},avoid]}];
assert.equal(embeddingTexts(people).length,2);assert(embeddingTexts(people).every(t=>!t.includes('공포')));
assert.equal(rankSemantic(people,[[1,0],[1,0]]).length,1);
assert.equal(findMatches([{id:'a',interests:[liked]},{id:'b',interests:[liked]},{id:'c',interests:[{...liked,preference:'avoid'}]}]).length,0);
assert.equal(findMatches([{id:'a',interests:[{...liked,preference:undefined}]},{id:'b',interests:[liked]}]).length,1);
assert.equal(normalizeInstagram('@Example_User'),'example_user');assert.throws(()=>normalizeInstagram('https://instagram.com.evil.invalid/name'));
sqlite.exec('ALTER TABLE profiles DROP COLUMN instagram_handle; ALTER TABLE profiles DROP COLUMN instagram_visible;');
await ensureProfileColumns(DB);await ensureProfileColumns(DB);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM profiles WHERE owner NOT LIKE 'demo:%'").get().n,3);
assert.equal(sqlite.prepare('SELECT instagram_visible FROM profiles WHERE id=?').get(aid).instagram_visible,'private');
console.log('PASS: persisted preferences, backward compatibility, avoidance filtering, Qwen3 input filtering, Instagram anonymous/pending/room denial, accepted-friend access, revocation, URL validation');


assert.equal(normalizeLinkedIn('https://www.linkedin.com/in/test-person/'),'test-person');
assert.throws(()=>normalizeLinkedIn('https://evil.invalid/in/test'));
assert.throws(()=>normalizeLinkedIn('https://www.linkedin.com/company/test'));
await call({...saveA,linkedinHandle:'https://www.linkedin.com/in/test-person/',linkedinVisible:true},a);
assert.equal((await call(undefined,a)).data.me.linkedinHandle,'test-person');
assert.equal((await call(undefined,c,'?profile='+aid)).data.profile.linkedinHandle,undefined);
await call({action:'requestFriend',id:bid},a);await call({action:'acceptFriend',id:aid},b);
assert.equal((await call(undefined,b,'?profile='+aid)).data.profile.linkedinHandle,'test-person');
assert((await call(undefined,c,'?room='+room)).data.selectedRoom.members.every(p=>p.linkedinHandle===undefined));
await call({...saveA,linkedinHandle:'test-person',linkedinVisible:false},a);
assert.equal((await call(undefined,b,'?profile='+aid)).data.profile.linkedinHandle,undefined);
console.log('PASS LinkedIn optional profile validation and friend-only visibility');

sqlite.close();
