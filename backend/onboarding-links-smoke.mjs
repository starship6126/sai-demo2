import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {api} from './api.mjs';
const sql=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort()){if(f.startsWith('0001_'))sql.exec("ALTER TABLE profiles ADD COLUMN instagram_handle TEXT NOT NULL DEFAULT ''; ALTER TABLE profiles ADD COLUMN instagram_visible TEXT NOT NULL DEFAULT 'private';");sql.exec(fs.readFileSync('drizzle/'+f,'utf8'));}
const DB={prepare(query){const stmt=sql.prepare(query);let args=[];return {bind(...v){args=v;return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return stmt.run(...args);}};},async batch(stmts){return Promise.all(stmts.map(s=>s.run()));}};
async function call(body,token='',q=''){
 if(body?.action==='saveProfile'&&body.version===undefined&&token)body={...body,version:(await call(undefined,token)).data.me?.version??null};const r=await api(new Request('https://test.invalid/api/app'+q,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})}),{DB});return {status:r.status,data:await r.json()};}
const pass='local-test-password',signup={action:'register',username:'social_signup',password:pass,confirmPassword:pass,instagramHandle:'https://www.instagram.com/Sai_Test/',linkedinHandle:'https://www.linkedin.com/in/sai-test/'};
assert.equal((await call({...signup,username:'invalid_social',linkedinHandle:'https://evil.invalid/in/test'})).status,400);
assert.equal(sql.prepare('SELECT username FROM accounts WHERE username=?').get('invalid_social'),undefined);
const registration=await call(signup);assert.equal(registration.status,200);let token=registration.data.token;
let state=(await call(undefined,token)).data;assert.equal(state.me,null);assert.equal(state.account.instagramHandle,'sai_test');assert.equal(state.account.linkedinHandle,'sai-test');assert.equal((await call()).data.account,null);
await call({action:'logout'},token);token=(await call({action:'login',username:signup.username,password:pass})).data.token;
state=(await call(undefined,token)).data;assert.equal(state.account.instagramHandle,'sai_test');assert.equal(state.account.linkedinHandle,'sai-test');
const save=await call({action:'saveProfile',name:'SNS Test',interests:[]},token);assert.equal(save.status,200);
state=(await call(undefined,token)).data;assert.equal(state.me.instagramHandle,'sai_test');assert.equal(state.me.linkedinHandle,'sai-test');assert.equal(state.me.instagramVisible,false);assert.equal(state.me.linkedinVisible,false);assert.equal(state.account.instagramHandle,'');assert.equal(state.account.linkedinHandle,'');
const publicView=(await call(undefined,'','?profile='+save.data.id)).data.profile;assert.equal(publicView.instagramHandle,undefined);assert.equal(publicView.linkedinHandle,undefined);
await call({action:'saveProfile',name:'SNS Test',interests:[],instagramHandle:'',linkedinHandle:''},token);await call({action:'deleteProfile'},token);
state=(await call(undefined,token)).data;assert.equal(state.account.instagramHandle,'');assert.equal(state.account.linkedinHandle,'');
console.log('PASS signup SNS draft, login/reload recovery, initial profile persistence, private defaults, invalid URL and removal');
