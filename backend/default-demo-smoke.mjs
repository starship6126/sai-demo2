import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {api} from './api.mjs';
import {demoProfiles} from './demo-fixtures.mjs';
import {optimizeGroups} from './group-optimizer.mjs';

const sqlite=new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys=ON');
for(const file of fs.readdirSync('drizzle').filter(name=>name.endsWith('.sql')).sort()){
 if(file.startsWith('0001_'))sqlite.exec("ALTER TABLE profiles ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT ''; ALTER TABLE profiles ADD COLUMN instagram_visible TEXT NOT NULL DEFAULT 'private';");
 sqlite.exec(fs.readFileSync(`drizzle/${file}`,'utf8'));
}

const DB={
 prepare(query){
  const statement=sqlite.prepare(query);let values=[];
  return {bind(...args){values=args;return this;},async first(){return statement.get(...values)||null;},async all(){return {results:statement.all(...values)};},async run(){return statement.run(...values);}};
 },
 async batch(statements){
  sqlite.exec('BEGIN');
  try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}
  catch(error){sqlite.exec('ROLLBACK');throw error;}
 },
};
const environment={DB,optimizeGroups,fetch:async()=>{throw new Error('default demo smoke must not use the network');}};

async function call({body,token='',query=''}={}){
 if(body?.action==='saveProfile'&&body.version===undefined&&token)body={...body,version:(await call({token})).data.me?.version??null};
 const response=await api(new Request(`https://test.invalid/api/app${query}`,{
  method:body===undefined?'GET':'POST',
  headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
 }),environment);
 return {status:response.status,data:await response.json()};
}
async function account(username,name,interests=[]){
 const password='demo-default-password-123';
 const registration=await call({body:{action:'register',username,password,confirmPassword:password}});
 assert.equal(registration.status,200);
 const token=registration.data.token;
 const saved=await call({token,body:{action:'saveProfile',name,interests}});
 assert.equal(saved.status,200);
 return {token,id:saved.data.id};
}

const fixtureProfiles=demoProfiles();
const fixtureIds=fixtureProfiles.map(profile=>profile.id);
assert.equal(fixtureProfiles.length,24);
assert.deepEqual(fixtureIds,Array.from({length:24},(_,index)=>`demo-${String(index+1).padStart(2,'0')}`));

const anonymous=await call();
assert.equal(anonymous.status,200);
assert.equal(anonymous.data.account,null);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,0);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM rooms').get().count,0);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM friendships').get().count,0);

const legacyOwner='legacy-owner';
const legacyProfile='legacy-profile';
const legacyToken='legacy-session-token';
const legacyHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(legacyToken)))].map(value=>value.toString(16).padStart(2,'0')).join('');
sqlite.prepare("INSERT INTO accounts(owner,username,password_hash,created) VALUES(?,?,?,?)").run(legacyOwner,'legacy_user','legacy-password-record','2026-01-01T00:00:00.000Z');
sqlite.prepare("INSERT INTO profiles(id,owner,name,bio,interests,color,created) VALUES(?,?,?,?,?,?,?)").run(legacyProfile,legacyOwner,'기존 사용자','',JSON.stringify([{id:'legacy-interest',label:'기존 취향',category:'기타',shared:true,preference:'like'}]),'#3154F5','2026-01-01T00:00:00.000Z');
sqlite.prepare('INSERT INTO sessions(token_hash,owner,created) VALUES(?,?,?)').run(legacyHash,legacyOwner,new Date().toISOString());
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM profiles WHERE id LIKE 'demo-%'").get().count,0);
const legacyState=(await call({token:legacyToken})).data;
assert.equal(legacyState.friends.length,24,'An already-saved profile receives defaults lazily on authenticated GET.');
assert.equal(legacyState.rooms.length,1);
assert.equal(legacyState.rooms[0].name,'24명 데모 모임');
assert.equal(legacyState.me.interests[0].id,'legacy-interest');

const privateInterest={id:'alice-private',label:'나만의 비공개 취향',category:'기타',shared:false,preference:'like'};
const sharedInterest={id:'alice-shared',label:'일본 음악',category:'음악',shared:true,preference:'like'};
const alice=await account('default_demo_alice','앨리스',[privateInterest,sharedInterest]);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM profiles WHERE id LIKE 'demo-%'").get().count,24,'Saving a new profile seeds the shared fixtures without duplicating them.');

const aliceInitial=await call({token:alice.token});
assert.equal(aliceInitial.status,200);
assert.equal(aliceInitial.data.friends.length,24);
assert.deepEqual(aliceInitial.data.friends.map(friend=>friend.id).sort(),fixtureIds.slice().sort());
assert.equal(aliceInitial.data.rooms.length,1);
assert.equal(aliceInitial.data.rooms[0].name,'24명 데모 모임');
assert.equal(aliceInitial.data.rooms[0].count,25);
assert.equal(aliceInitial.data.rooms[0].isDemo,true);
assert.deepEqual(aliceInitial.data.me.interests.map(interest=>interest.id).sort(),[privateInterest.id,sharedInterest.id].sort());
for(const fixture of fixtureProfiles){
 const friend=aliceInitial.data.friends.find(candidate=>candidate.id===fixture.id);
 assert(friend,`${fixture.id} must be returned as a default friend.`);
 assert.equal(friend.name,fixture.name);
 assert.equal(friend.isDemo,true);
 assert.deepEqual(friend.interests.map(interest=>[interest.id,interest.label,interest.category]),fixture.interests.map(interest=>[interest.id,interest.label,interest.category]));
 assert.deepEqual(friend.interests.map(interest=>interest.score),fixture.interests.map(interest=>interest.score));
 assert(friend.interests.every(interest=>interest.shared===true));
 assert(friend.interests.every(interest=>interest.source?.kind==='demo'&&interest.source.label&&interest.source.detail));
}
const aliceDemoRoom=aliceInitial.data.rooms[0].id;
const aliceSelected=(await call({token:alice.token,query:`?room=${encodeURIComponent(aliceDemoRoom)}`})).data.selectedRoom;
assert.equal(aliceSelected.isDemo,true);
assert.equal(aliceSelected.members.length,25);
assert.deepEqual(aliceSelected.members.filter(member=>member.isDemo).map(member=>member.id).sort(),fixtureIds.slice().sort());
assert(aliceSelected.members.some(member=>member.id===alice.id));

const friendAnalysis=await call({token:alice.token,body:{action:'analyze',profileIds:[alice.id,'demo-01']}});
assert.equal(friendAnalysis.status,200);
assert.deepEqual(friendAnalysis.data.people.map(person=>person.id),[alice.id,'demo-01']);
assert(friendAnalysis.data.people.find(person=>person.id===alice.id).interests.some(interest=>interest.id===sharedInterest.id));
assert(!friendAnalysis.data.people.find(person=>person.id===alice.id).interests.some(interest=>interest.id===privateInterest.id));
const roomAnalysis=await call({token:alice.token,body:{action:'analyze',room:aliceDemoRoom,profileIds:['demo-01','demo-02']}});
assert.equal(roomAnalysis.status,200);
assert.deepEqual(roomAnalysis.data.people.map(person=>person.id).sort(),['demo-01','demo-02']);

const optimized=await call({token:alice.token,body:{action:'optimizeGroups',room:aliceDemoRoom,selected:fixtureIds,size:4}});
assert.equal(optimized.status,200);
assert.equal(optimized.data.engine,'taxonomy+cp-sat');
assert(optimized.data.plans.length>0);
const chosen=optimized.data.plans[0];
assert.equal(chosen.algorithm,'ortools-cp-sat');
assert(['OPTIMAL','FEASIBLE'].includes(chosen.solverStatus));
assert.deepEqual(chosen.groups.flatMap(group=>group.ids).sort(),fixtureIds.slice().sort());
const savedAssignment={size:4,selected:fixtureIds,groups:chosen.groups.map(group=>group.ids),unassigned:chosen.unassigned};
assert.equal((await call({token:alice.token,body:{action:'saveRoomPlan',room:aliceDemoRoom,plan:savedAssignment}})).status,200);
const aliceReloaded=(await call({token:alice.token,query:`?room=${encodeURIComponent(aliceDemoRoom)}`})).data;
assert.equal(aliceReloaded.friends.length,24);
assert.deepEqual(aliceReloaded.me.interests.map(interest=>interest.id).sort(),[privateInterest.id,sharedInterest.id].sort());
assert.deepEqual(aliceReloaded.selectedRoom.plan.groups,savedAssignment.groups);

const bob=await account('default_demo_bob','밥',[{id:'bob-shared',label:'협동 게임',category:'게임',shared:true,preference:'like'}]);
const bobInitial=(await call({token:bob.token})).data;
assert.equal(bobInitial.friends.length,24);
assert.equal(bobInitial.rooms.length,1);
assert.equal(bobInitial.rooms[0].name,'24명 데모 모임');
assert.equal(bobInitial.rooms[0].count,25);
assert.notEqual(bobInitial.rooms[0].id,aliceDemoRoom);
const bobDemoRoom=bobInitial.rooms[0].id;
const bobSelected=(await call({token:bob.token,query:`?room=${encodeURIComponent(bobDemoRoom)}`})).data.selectedRoom;
assert.equal(bobSelected.plan,null);
assert(bobSelected.members.some(member=>member.id===bob.id));
assert(!bobSelected.members.some(member=>member.id===alice.id));
assert.equal((await call({token:bob.token,query:`?room=${encodeURIComponent(aliceDemoRoom)}`})).data.selectedRoom,null);
assert.equal((await call({token:bob.token,body:{action:'saveRoomPlan',room:aliceDemoRoom,plan:savedAssignment}})).status,403);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM profiles WHERE id LIKE 'demo-%'").get().count,24,'Fixture profiles must be shared globally.');

assert.equal((await call({token:alice.token,body:{action:'requestFriend',id:bob.id}})).status,200);
assert.equal((await call({token:bob.token,body:{action:'acceptFriend',id:alice.id}})).status,200);
const realRoom=(await call({token:alice.token,body:{action:'createRoom',name:'실제 친구 모임'}})).data.id;
assert.equal((await call({token:bob.token,body:{action:'joinRoom',id:realRoom}})).status,200);
const withRealData=(await call({token:alice.token})).data;
assert.equal(withRealData.friends.length,25);
assert(withRealData.friends.some(friend=>friend.id===bob.id&&!friend.isDemo));
assert(withRealData.rooms.some(room=>room.id===realRoom&&room.name==='실제 친구 모임'&&!room.isDemo));
assert(withRealData.rooms.some(room=>room.id===aliceDemoRoom&&room.isDemo));

assert.equal((await call({token:alice.token,body:{action:'removeFriend',id:'demo-01'}})).status,200);
assert.equal((await call({token:alice.token,body:{action:'leaveRoom',id:aliceDemoRoom}})).status,200);
assert.equal((await call({token:alice.token,body:{action:'saveProfile',name:'앨리스 수정',interests:[privateInterest,sharedInterest]}})).status,200);
for(let attempt=0;attempt<2;attempt++){
 const state=(await call({token:alice.token})).data;
 assert(!state.friends.some(friend=>friend.id==='demo-01'),'Removed demo friends must stay removed.');
 assert(!state.rooms.some(room=>room.id===aliceDemoRoom),'Leaving the initialized demo room must persist.');
 assert(state.friends.some(friend=>friend.id===bob.id),'Real friendships must be preserved.');
 assert(state.rooms.some(room=>room.id===realRoom),'Real rooms must be preserved.');
 assert.deepEqual(state.me.interests.map(interest=>interest.id).sort(),[privateInterest.id,sharedInterest.id].sort());
}
assert(sqlite.prepare('SELECT id FROM rooms WHERE id=?').get(aliceDemoRoom),'The demo room row remains the initialization marker after its owner leaves.');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM members WHERE room=? AND profile=?').get(aliceDemoRoom,alice.id).count,0);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM friendships WHERE status='accepted' AND ((sender=? AND recipient='demo-01') OR (sender='demo-01' AND recipient=?))").get(alice.id,alice.id).count,0);

assert.equal((await call({token:alice.token,body:{action:'deleteProfile'}})).status,200);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id=?').get(aliceDemoRoom).count,0);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM members WHERE room=?').get(aliceDemoRoom).count,0);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM room_plans WHERE room=?').get(aliceDemoRoom).count,0);
assert(sqlite.prepare('SELECT id FROM rooms WHERE id=?').get(realRoom),'Profile deletion does not remove ordinary rooms.');
assert(sqlite.prepare('SELECT id FROM rooms WHERE id=?').get(bobDemoRoom),'Other accounts keep their default rooms.');
assert.equal((await call({token:alice.token})).data.me,null);
const recreated=await call({token:alice.token,body:{action:'saveProfile',name:'새 앨리스',interests:[sharedInterest]}});
assert.equal(recreated.status,200);
assert.notEqual(recreated.data.id,alice.id);
const recreatedState=(await call({token:alice.token})).data;
assert.equal(recreatedState.friends.length,24);
assert.equal(recreatedState.rooms.length,1);
assert.equal(recreatedState.rooms[0].id,`demo-room-${recreated.data.id}`);
assert.equal(recreatedState.rooms[0].count,25);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM profiles WHERE id LIKE 'demo-%'").get().count,24);

console.log('PASS lazy 24-person defaults, canonical demo evidence, idempotency, opt-outs, account isolation, real data preservation, authorized analysis, real CP-SAT, saved-plan reload, and profile deletion/recreation.');
sqlite.close();
