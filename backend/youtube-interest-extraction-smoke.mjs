import assert from 'node:assert/strict';
import {extractYouTubeInterests,YOUTUBE_INTEREST_SCHEMA} from './youtube-interest-extraction.mjs';

const channels=Array.from({length:5},(_,index)=>({id:`channel-${index+1}`,title:index===0?'Jazz Sessions':`채널 ${index+1} ${'\\"긴 제목 '.repeat(20)}`,description:`재즈 피아노 즉흥연주와 라이브 공연 설명 ${'상세 '.repeat(200)}`,url:`https://www.youtube.com/channel/channel-${index+1}`}));
const output=interests=>Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:JSON.stringify({interests})}]}]});
let requestBody;const five=[{label:'재즈 피아노 즉흥연주',category:'음악',refs:[1,2,3]},{label:'라이브 공연 감상',category:'음악',refs:[2,4]},{label:'화성학 학습',category:'공부·일',refs:[1,3]},{label:'드럼 리듬 연습',category:'음악',refs:[4,5]},{label:'음반 리뷰 탐색',category:'콘텐츠',refs:[3,5]}];const valid=await extractYouTubeInterests(channels,{GEMINI_API_KEY:'secret',fetch:async(url,init)=>{assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/interactions');requestBody=JSON.parse(init.body);return output(five);}});assert.equal(valid.interests.length,5);assert(requestBody.input.length<=1000);assert.equal(valid.inputLength,requestBody.input.length);assert.equal(requestBody.store,false);assert.deepEqual(requestBody.response_format.schema,YOUTUBE_INTEREST_SCHEMA);assert.equal(requestBody.response_format.schema.properties.interests.items.properties.refs.minItems,undefined);assert(!JSON.stringify(requestBody).includes('secret'));
await assert.rejects(extractYouTubeInterests(channels,{}),error=>error.code==='NOT_CONFIGURED');
for(const bad of [
 [{label:'Jazz Sessions',category:'음악',refs:[1]}],
 [{label:'취미',category:'기타',refs:[1]}],
 [{label:'재즈 피아노 즉흥연주',category:'음악',refs:[6]}],
 [{label:'재즈 피아노 즉흥연주',category:'음악',refs:[1,2,3,4,5,5]}],
 [{label:'재즈 피아노 즉흥연주',category:'음악',refs:[1]},{label:'재즈 피아노 즉흥연주',category:'콘텐츠',refs:[2]}],
])await assert.rejects(extractYouTubeInterests(channels,{GEMINI_API_KEY:'secret',fetch:async()=>output(bad)}),error=>error.code==='INVALID_RESULT');
await assert.rejects(extractYouTubeInterests(channels,{GEMINI_API_KEY:'secret',fetch:async()=>Response.json({status:'in_progress'})}),error=>error.code==='INVALID_RESULT');
const sensitiveChannels=channels.map((channel,index)=>({...channel,title:index===0?'문의 contact@example.com':`음악 채널 ${index+1}`,description:'재즈 공연 · 문의 support@example.com'}));
let sensitiveCalls=0;
const cleaned=await extractYouTubeInterests(sensitiveChannels,{GEMINI_API_KEY:'secret',fetch:async(_url,init)=>{
 sensitiveCalls++;
 const input=JSON.parse(init.body).input;
 assert(input.length<=1000);
 assert(input.includes('contact@example.com'),'sensitive source text must not block the Gemini request');
 assert.match(input,/민감정보를 삭제/);
 assert.match(input,/중단하지 말고/);
 return output([{label:'contact@example.com',category:'기타',refs:[1]},five[0],{label:'010-1234-5678',category:'기타',refs:[2]}]);
}});
assert.equal(sensitiveCalls,1);
assert.deepEqual(cleaned.interests,[five[0]],'remaining sensitive results must not discard valid interests');
await assert.rejects(extractYouTubeInterests(sensitiveChannels,{GEMINI_API_KEY:'secret',fetch:async()=>output([{label:'contact@example.com',category:'기타',refs:[1]}])}),error=>error.code==='EMPTY_RESULT');
await assert.rejects(extractYouTubeInterests(channels,{GEMINI_API_KEY:'secret',fetch:async()=>output([])}),error=>error.code==='EMPTY_RESULT');
assert.equal(YOUTUBE_INTEREST_SCHEMA.properties.interests.minItems,1);
const single=await extractYouTubeInterests(channels.slice(0,1),{GEMINI_API_KEY:'secret',fetch:async(_url,init)=>{
 const body=JSON.parse(init.body);assert.match(body.input,/채널 1개/);assert.match(body.input,/반드시/);assert(!body.input.includes('빈 배열'));assert(body.input.length<=1000);
 return output([{label:'재즈 피아노 즉흥연주',category:'음악',refs:[1]}]);
}});
assert.equal(single.interests.length,1);
console.log('PASS: Gemini requests at least one grounded keyword, accepts one selected channel, keeps input within 1000 characters, removes sensitive results, and rejects empty/malformed output');
