import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {api} from './api.mjs';
import {previewLinkedInText,LINKEDIN_TEXT_LIMIT} from '../shared/linkedin-preview.ts';

const text='보유 기술:\n• React\n• SQL\n• C\n\n경력:\n개발자\n\n관심사: 재즈, 독서\nSkills: React, SQL, test@example.com, https://example.com, 010-1234-5678';
const rows=previewLinkedInText(text);
assert.deepEqual(rows.map(t=>[t.label,t.category]),[['React','공부·일'],['SQL','공부·일'],['C','공부·일'],['재즈','기타'],['독서','기타']]);
assert(rows.every(t=>text.includes(t.evidence)));
assert.equal(previewLinkedInText('저는 개발자이며 머신러닝에 관심이 있습니다.').length,0);
assert.equal(previewLinkedInText('Skills: '+Array.from({length:40},(_,i)=>'기술'+i).join(', ')).length,30);
assert.equal(previewLinkedInText('Interests: DAY6, 데이식스').length,1);
assert.deepEqual(previewLinkedInText('Skills： R; C++\nExperience\n개발자').map(t=>t.label),['R','C++']);
assert.equal(previewLinkedInText('Skills\nReact\n\nJane Person').length,1);
assert.deepEqual(previewLinkedInText('Skills: React, 02-1234-5678, 031 234 5678, +82 2 1234 5678').map(t=>t.label),['React']);
assert.deepEqual(previewLinkedInText('Skills\nReact\nCertifications\nAWS Certified').map(t=>t.label),['React']);
assert.deepEqual(previewLinkedInText('보유 기술\nSQL\n자격증\n정보처리기사').map(t=>t.label),['SQL']);

const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
for(const file of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()){
 if(file.startsWith('0001_'))sql.exec("ALTER TABLE profiles ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT ''; ALTER TABLE profiles ADD COLUMN instagram_visible TEXT NOT NULL DEFAULT 'private';");
 sql.exec(fs.readFileSync('drizzle/'+file,'utf8'));
}
const DB={prepare(query){const stmt=sql.prepare(query);let args=[];return {bind(...values){args=values;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return stmt.run(...args);}};},async batch(stmts){sql.exec('BEGIN');try{const results=[];for(const stmt of stmts)results.push(await stmt.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
async function call(body,token='',q=''){
 if(body?.action==='saveProfile'&&body.version===undefined&&token)body={...body,version:(await call(undefined,token)).data.me?.version??null};
 const response=await api(new Request('https://test.invalid/api/app'+q,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),{DB});
 return {status:response.status,data:await response.json()};
}
assert.equal((await call({action:'previewLinkedInText',text})).status,401);
const password='preview-test-password';
const registered=await call({action:'register',username:'preview_test',password,confirmPassword:password});
assert.equal(registered.status,200);
const token=registered.data.token;
const initial=await call({action:'previewLinkedInText',text},token);
assert.equal(initial.status,200,'Candidates are available before creating the first profile');
assert.equal((await call(undefined,token)).data.me,null);
assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM source_syncs').get().count,0);
const existing={id:'manual',label:'SQL',category:'공부·일',preference:'avoid',shared:true};
const saved=await call({action:'saveProfile',name:'미리보기 검증',interests:[existing]},token);
assert.equal(saved.status,200);
const preview=await call({action:'previewLinkedInText',text},token);
assert.equal(preview.status,200);
assert.equal(preview.data.count,5);
assert(preview.data.candidates.every(t=>t.shared===false&&t.source===undefined));
assert.deepEqual((await call(undefined,token)).data.me.interests,[existing],'Preview must not change saved preferences');
assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM source_syncs').get().count,0);
for(const invalid of ['', ' '.repeat(20),42,'Skills: '+'x'.repeat(LINKEDIN_TEXT_LIMIT)])assert.equal((await call({action:'previewLinkedInText',text:invalid},token)).status,400);
assert.equal((await call({action:'previewLinkedInText',text:'경력: 소프트웨어 개발자'},token)).status,400);
const selected={...preview.data.candidates.find(t=>t.label==='React'),preference:'explore'};
assert.equal((await call({action:'saveProfile',name:'미리보기 검증',interests:[existing,selected]},token)).status,200);
const state=(await call(undefined,token)).data;
assert.equal(state.me.interests.length,2);
assert.equal(state.me.interests[0].preference,'avoid');
assert.equal(state.me.interests[1].preference,'explore');
assert.equal(state.me.interests[1].shared,false);
assert.equal(state.me.interests[1].source,undefined);
const publicView=(await call(undefined,'','?profile='+saved.data.id)).data.profile;
assert(!publicView.interests.some(t=>t.id===selected.id));
console.log('PASS LinkedIn preview: explicit sections, original evidence, input limits, no inferred career preferences, no writes before confirmation, selected private save');
