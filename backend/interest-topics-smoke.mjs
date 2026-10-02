import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {assertInterestTopicCapacity,evidenceContainsLabel,interestTopicStatements,loadInterestTopics,normalizeInterestRecords} from './interest-topics.mjs';

const vectors=new Map([
 ['음악 재즈',[1,0,0]],['음악 재즈 채널 · 구독 채널',[.98,.1,0]],
 ['야간 산책 · 영상 모음',[0,1,0]],['운동 야간 러닝',[0,.98,.1]],
 ['완전히 무관한 원문',[1,0,0]],['게임 전략 게임',[0,1,0]],
 ['A · source',[1,0,0]],['B · source',[.99,.01,0]],['음악 라이브 음악',[1,0,0]],['음악 라이브-음악',[1,0,0]],['음악 콘서트 감상',[.99,.01,0]],
 ['C',[0,1,0]],['D',[0,.99,.01]],['운동 저녁 운동',[0,1,0]],
]);
const embed=async texts=>texts.map(text=>vectors.get(text)||[0,0,1]);

assert.equal(evidenceContainsLabel('Applied Artificial Intelligence','We build APPLIED   ARTIFICIAL INTELLIGENCE products.'),true);
assert.equal(evidenceContainsLabel('AI','chair systems'),false,'Latin labels require word boundaries');
assert.equal(evidenceContainsLabel('A','A systems'),false,'one-character labels are not grounded');
assert.equal(evidenceContainsLabel('Python',''),false);

const literalEvidenceOnly=await normalizeInterestRecords([{id:'literal',label:'Applied Artificial Intelligence',category:'공부·일',evidence:'We build Applied Artificial Intelligence products.',evidenceOnly:true}],[],{embedTexts:async texts=>texts.map(text=>text.startsWith('공부·일')?[0,1]:[1,0]),generateTopics:async()=>[{label:'Applied Artificial Intelligence',category:'공부·일',refs:['literal']}]});
assert.equal(literalEvidenceOnly.interests[0].label,'Applied Artificial Intelligence','literal evidence-only labels survive low cosine grounding while Qwen still runs');
const missingEvidenceOnly=await normalizeInterestRecords([{id:'missing',label:'Python',category:'공부·일',evidenceOnly:true}],[],{embedTexts:embed,generateTopics:async()=>[{label:'Python',category:'공부·일',refs:['missing']}]});
assert.deepEqual(missingEvidenceOnly.interests,[],'evidence-only records require evidence');

let generated=false;
const reused=await normalizeInterestRecords([{id:'r1',label:'재즈 채널',category:'음악',evidence:'구독 채널'}],[{id:'topic-jazz',label:'재즈',category:'음악'}],{embedTexts:embed,generateTopics:async()=>{generated=true;return [];}});
assert.equal(generated,false,'an existing Qwen match bypasses Gemini');
assert.deepEqual(reused.interests,[{label:'재즈',category:'음악',topicId:'topic-jazz',evidence:'재즈 채널 · 구독 채널'}]);
assert.deepEqual(reused.topics,[{id:'topic-jazz',label:'재즈',category:'음악'}],'represented catalog topics are returned for guarded persistence');
assert.deepEqual(reused.stats,{reused:1,created:0,rejected:0});

const created=await normalizeInterestRecords([{id:'walk',label:'야간 산책',evidence:'영상 모음'}],[],{embedTexts:embed,generateTopics:async rows=>{assert.equal(rows[0].label,'야간 산책');return [{label:'야간 러닝',category:'운동',refs:['walk'],evidence:'Gemini가 지어낸 근거'}];}});
assert.equal(created.topics.length,1);
assert.equal(created.interests[0].label,'야간 러닝');
assert.equal(created.interests[0].evidence,'야간 산책 · 영상 모음','only original source evidence is retained');
assert.equal(created.interests[0].topicId,created.topics[0].id);

const rejected=await normalizeInterestRecords([{id:'real',label:'완전히 무관한 원문'}],[],{embedTexts:embed,generateTopics:async()=>[
 {label:'전략 게임',category:'게임',refs:['real','forged']},
]});
assert.deepEqual(rejected.interests,[],'a candidate containing any forged reference is rejected as a whole');
assert.equal(rejected.topics.length,0);

const duplicate=await normalizeInterestRecords([{id:'a',label:'A',evidence:'source'},{id:'b',label:'B',evidence:'source'}],[],{maxTopics:5,embedTexts:embed,generateTopics:async()=>[
 {label:'라이브 음악',category:'음악',refs:['a']},
 {label:'라이브-음악',category:'음악',refs:['b']},
]});
assert.equal(duplicate.topics.length,1,'canonical duplicate generated topics share one catalog row');
assert.equal(new Set(duplicate.interests.map(row=>row.topicId)).size,1);
assert.match(duplicate.interests[0].evidence,/A · source/);assert.match(duplicate.interests[0].evidence,/B · source/);
const semanticDuplicate=await normalizeInterestRecords([{id:'a',label:'A',evidence:'source'},{id:'b',label:'B',evidence:'source'}],[],{embedTexts:embed,generateTopics:async()=>[
 {label:'라이브 음악',category:'음악',refs:['a']},{label:'콘서트 감상',category:'음악',refs:['b']},
]});
assert.equal(semanticDuplicate.topics.length,1,'later generated topics are compared with earlier minted vectors');

const distinctCap=await normalizeInterestRecords([{id:'a',label:'A',evidence:'source'},{id:'b',label:'B',evidence:'source'},{id:'c',label:'C'},{id:'d',label:'D'}],[],{maxTopics:2,embedTexts:embed,generateTopics:async()=>[
 {label:'라이브 음악',category:'음악',refs:['a','b']},
 {label:'저녁 운동',category:'운동',refs:['c','d']},
]});
assert.equal(distinctCap.topics.length,2,'maxTopics counts distinct normalized topics');
assert.equal(distinctCap.interests.length,2);

await assert.rejects(()=>normalizeInterestRecords([{id:'x',label:'valid'}],[],{embedTexts:async()=>[[NaN]],generateTopics:async()=>[]}),/invalid number/);
await assert.rejects(()=>normalizeInterestRecords([{id:'x',label:'valid'}],[],{embedTexts:async()=>[[0,0]],generateTopics:async()=>[]}),/zero magnitude/);
await assert.rejects(()=>normalizeInterestRecords([{id:'x',label:'valid'}],[{id:'t',label:'topic',category:'기타'}],{embedTexts:async()=>[[1],[1,0]],generateTopics:async()=>[]}),/dimensions/);
const controller=new AbortController();controller.abort(new DOMException('cancelled','AbortError'));
await assert.rejects(()=>normalizeInterestRecords([{id:'x',label:'valid'}],[],{signal:controller.signal,embedTexts:embed,generateTopics:async()=>[]}),error=>error.name==='AbortError');

const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
sqlite.exec(fs.readFileSync('drizzle/0000_odd_exiles.sql','utf8'));
sqlite.exec(fs.readFileSync('drizzle/0008_interest_topics.sql','utf8'));
const DB={prepare(query){const statement=sqlite.prepare(query);let args=[];return {bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return {results:statement.all(...args)};},async run(){return statement.run(...args);}};},async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const statement of statements)out.push(await statement.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
sqlite.prepare("INSERT INTO profiles(id,owner,name,bio,interests,color,created) VALUES(?,?,?,?,?,?,?)").run('p1','owner-1','one','',JSON.stringify([{id:'old',label:'Seed',category:'기타',preference:'like'}]),'#000','now');
sqlite.prepare("INSERT INTO profiles(id,owner,name,bio,interests,color,created) VALUES(?,?,?,?,?,?,?)").run('p2','owner-2','two','','[]','#000','now');
sqlite.prepare('INSERT INTO interest_topics VALUES(?,?,?,?,?,?)').run('private-1','owner-1','음악:비밀','비밀','음악','now');
sqlite.prepare('INSERT INTO interest_topics VALUES(?,?,?,?,?,?)').run('private-2','owner-2','음악:다른비밀','다른 비밀','음악','now');
const loaded=await loadInterestTopics(DB,'owner-1',[{label:'Seed',category:'기타',preference:'like'},{label:'Avoid',category:'기타',preference:'avoid'},{label:'Known',category:'음악',topicId:'known-id'}]);
assert(loaded.some(row=>row.id==='private-1'));
assert(loaded.some(row=>row.id==='known-id'));
assert(loaded.some(row=>row.id.startsWith('candidate-')));
assert(!loaded.some(row=>row.id==='private-2'||row.label==='Avoid'),'catalogs are account-scoped and avoid interests are excluded');
const ownerOneSeed=(await loadInterestTopics(DB,'owner-1',[{label:'Same manual topic',category:'기타'}])).find(row=>row.label==='Same manual topic');
const ownerTwoSeed=(await loadInterestTopics(DB,'owner-2',[{label:'Same manual topic',category:'기타'}])).find(row=>row.label==='Same manual topic');
assert.notEqual(ownerOneSeed.id,ownerTwoSeed.id,'deterministic seed IDs are owner-scoped');
assert.match(ownerOneSeed.id,/^candidate-owner-1-[a-f0-9]{8}$/);
assert.match(ownerTwoSeed.id,/^candidate-owner-2-[a-f0-9]{8}$/);
const sameSerialized='[{"label":"Same manual topic"}]';sqlite.prepare('UPDATE profiles SET interests=?').run(sameSerialized);
await DB.batch(interestTopicStatements(DB,'owner-1',[ownerOneSeed],{serializedInterests:sameSerialized}));
await DB.batch(interestTopicStatements(DB,'owner-2',[ownerTwoSeed],{serializedInterests:sameSerialized}));
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM interest_topics WHERE canonical_key='기타:samemanualtopic'").get().count,2,'two owners can store the same manual seed without primary-key collision');
const hiddenByAvoid=await loadInterestTopics(DB,'owner-1',[{label:'비밀',category:'음악',preference:'avoid'}]);
assert.equal(hiddenByAvoid.find(row=>row.id==='private-1')?.avoid,true);
const avoidedNormalization=await normalizeInterestRecords([{id:'blocked',label:'some source'}],hiddenByAvoid,{embedTexts:async texts=>texts.map(text=>text==='some source'?[1,0]:[0,1]),generateTopics:async()=>[{label:'비밀',category:'음악',refs:['blocked']}]});
assert.deepEqual(avoidedNormalization.interests,[],'historical catalog topics excluded by a current avoid cannot be reused or reminted');

const resolved=await assertInterestTopicCapacity(DB,'owner-1',[{id:'replacement-id',label:'비밀',category:'음악'}]);
assert.equal(resolved[0].id,'private-1','capacity preflight resolves canonical catalog identity');

const missed='[{"id":"new"}]';
await DB.batch(interestTopicStatements(DB,'owner-1',[{id:'guarded',label:'Guarded',category:'기타'}],{serializedInterests:missed}));
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM interest_topics WHERE id='guarded'").get().count,0,'a failed profile CAS cannot write topics');
sqlite.prepare('UPDATE profiles SET interests=? WHERE owner=?').run(missed,'owner-1');
await DB.batch(interestTopicStatements(DB,'owner-1',[{id:'guarded',label:'Guarded',category:'기타'}],{serializedInterests:missed}));
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM interest_topics WHERE id='guarded'").get().count,1);
sqlite.exec('CREATE TABLE source_syncs(owner TEXT PRIMARY KEY, youtube_summary TEXT NOT NULL)');
sqlite.prepare('INSERT INTO source_syncs VALUES(?,?)').run('owner-1','new-summary');
await DB.batch(interestTopicStatements(DB,'owner-1',[{id:'source-guarded',label:'Source guarded',category:'기타'}],{serializedInterests:missed,youtubeSummary:'stale-summary'}));
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM interest_topics WHERE id='source-guarded'").get().count,0,'a missed YouTube source CAS cannot write topics');
await DB.batch(interestTopicStatements(DB,'owner-1',[{id:'source-guarded',label:'Source guarded',category:'기타'}],{serializedInterests:missed,youtubeSummary:'new-summary'}));
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM interest_topics WHERE id='source-guarded'").get().count,1);
sqlite.prepare("DELETE FROM profiles WHERE owner='owner-1'").run();
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM interest_topics WHERE owner='owner-1'").get().count,0,'profile deletion cascades its private catalog');
assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM interest_topics WHERE owner='owner-2'").get().count,2);
for(let index=2;index<200;index++)sqlite.prepare('INSERT INTO interest_topics VALUES(?,?,?,?,?,?)').run(`cap-${index}`,'owner-2',`기타:cap${index}`,`cap ${index}`,'기타','now');
await assert.rejects(()=>assertInterestTopicCapacity(DB,'owner-2',[{id:'overflow',label:'Overflow',category:'기타'}]),error=>error.code==='TOPIC_CAPACITY');

console.log('interest topics smoke passed');
