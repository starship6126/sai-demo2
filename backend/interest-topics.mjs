import {canonical,contactOrSensitive} from '../shared/matching.ts';

const MATCH_THRESHOLD=.75;
const CATEGORY_SET=new Set(['음악','게임','여행','운동','콘텐츠','음식','공부·일','기타']);
const BROAD_LABELS=new Set(['음악','게임','여행','운동','콘텐츠','음식','공부','일','공부일','기타','관심사','취미']);

function cleanText(value,max){
 const text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
 return text&&text.length<=max&&!contactOrSensitive(text)?text:'';
}

function cleanCategory(value,optional=false){
 const category=cleanText(value,30);
 if(!category)return optional?'':'기타';
 return CATEGORY_SET.has(category)?category:(optional?'':'기타');
}

export function evidenceContainsLabel(label,evidence){
 const needle=String(label??'').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g,' ').trim(),haystack=String(evidence??'').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g,' ').trim();
 if(needle.length<2||!haystack)return false;
 const latinWord=character=>/[a-z0-9_]/.test(character||'');
 for(let index=haystack.indexOf(needle);index>=0;index=haystack.indexOf(needle,index+1)){
  if((latinWord(needle[0])&&latinWord(haystack[index-1]))||(latinWord(needle.at(-1))&&latinWord(haystack[index+needle.length])))continue;
  return true;
 }
 return false;
}

function topicKey(label,category){return `${category}:${canonical(label)}`;}
function validGeneratedLabel(label,category){const key=canonical(label);return !!key&&key!==canonical(category)&&!BROAD_LABELS.has(key);}

function candidateId(owner,label,category){
 const input=topicKey(label,category);let hash=2166136261;
 for(let index=0;index<input.length;index++){hash^=input.charCodeAt(index);hash=Math.imul(hash,16777619);}
 return `candidate-${owner}-${(hash>>>0).toString(16).padStart(8,'0')}`;
}

function abort(signal){signal?.throwIfAborted();}
function capacityError(message){const error=new Error(message);error.code='TOPIC_CAPACITY';return error;}

function validateVectors(value,count){
 if(!Array.isArray(value)||value.length!==count)throw new Error('Qwen embedding response count mismatch');
 let dimensions=0;
 return value.map(vector=>{
  if(!Array.isArray(vector)||!vector.length)throw new Error('Qwen embedding response is malformed');
  if(!dimensions)dimensions=vector.length;
  if(vector.length!==dimensions)throw new Error('Qwen embedding dimensions do not match');
  let norm=0;const copy=vector.map(number=>{if(typeof number!=='number'||!Number.isFinite(number))throw new Error('Qwen embedding contains an invalid number');norm+=number*number;return number;});
  if(!(norm>0)&&Number.isFinite(norm))throw new Error('Qwen embedding vector has zero magnitude');
  if(!Number.isFinite(norm))throw new Error('Qwen embedding vector magnitude is invalid');
  const scale=Math.sqrt(norm);return copy.map(number=>number/scale);
 });
}

function cosine(left,right){
 if(left.length!==right.length)throw new Error('Qwen embedding dimensions do not match');
 let score=0;for(let index=0;index<left.length;index++)score+=left[index]*right[index];
 return Math.max(-1,Math.min(1,score));
}

async function embeddings(embedTexts,texts,signal,dimensions){
 abort(signal);
 try{
  const response=await embedTexts(texts,signal);abort(signal);
  const vectors=validateVectors(response,texts.length);
  if(dimensions&&vectors.some(vector=>vector.length!==dimensions))throw new Error('Qwen embedding dimensions do not match');
  return vectors;
 }catch(error){
  abort(signal);
  const failure=new Error(error instanceof Error?error.message:'Qwen embedding failed',{cause:error});failure.code='QWEN_FAILED';throw failure;
 }
}

function sourceEvidence(record){return record.evidenceOnly?record.evidence:(record.evidence?`${record.label} · ${record.evidence}`:record.label);}
function sourceEmbeddingText(record){if(record.evidenceOnly)return sourceEvidence(record);const label=record.category?`${record.category} ${record.label}`:record.label;return record.evidence&&canonical(record.evidence)!==canonical(record.label)?`${label} · ${record.evidence}`:label;}

export async function loadInterestTopics(db,owner,currentInterests){
 const safeOwner=String(owner||'');if(!safeOwner)return [];
 const current=Array.isArray(currentInterests)?currentInterests:[],avoids=new Set(current.filter(interest=>interest?.preference==='avoid').map(interest=>{
  const label=cleanText(interest?.label,60),category=cleanCategory(interest?.category);return label?topicKey(label,category):'';
 }).filter(Boolean));
 const rows=(await db.prepare('SELECT id,label,category FROM interest_topics WHERE owner=? ORDER BY created DESC LIMIT 201').bind(safeOwner).all()).results||[];
 if(rows.length>200)throw capacityError('Interest topic catalog exceeds its 200 topic limit');
 const out=[],ids=new Set(),keys=new Set();
 for(const row of rows){
  const label=cleanText(row?.label,60),category=cleanCategory(row?.category);
  if(!label||!row?.id)continue;const key=topicKey(label,category);if(ids.has(row.id)||keys.has(key))continue;
  ids.add(row.id);keys.add(key);out.push({id:String(row.id),label,category,...(avoids.has(key)?{avoid:true}:{})});
 }
 for(const interest of current){
  if(out.length>=200)break;
  if(!interest||interest.preference==='avoid')continue;
  const label=cleanText(interest.label,60),category=cleanCategory(interest.category);if(!label)continue;
  const id=typeof interest.topicId==='string'&&interest.topicId.trim()?interest.topicId.trim():candidateId(safeOwner,label,category),key=topicKey(label,category);
  if(ids.has(id)||keys.has(key))continue;ids.add(id);keys.add(key);out.push({id,label,category});
 }
 return out;
}

export async function assertInterestTopicCapacity(db,owner,topics){
 const safeOwner=String(owner||'');if(!safeOwner)throw new TypeError('owner is required');
 const stored=(await db.prepare('SELECT id,canonical_key FROM interest_topics WHERE owner=? LIMIT 201').bind(safeOwner).all()).results||[];
 if(stored.length>200)throw capacityError('Interest topic catalog exceeds its 200 topic limit');
 const byKey=new Map(stored.map(row=>[String(row.canonical_key),String(row.id)])),seen=new Set(),normalized=[];
 for(const topic of Array.isArray(topics)?topics:[]){
  const id=typeof topic?.id==='string'?topic.id.trim():'',label=cleanText(topic?.label,60),category=cleanCategory(topic?.category);
  if(!id||id.length>100||!label)throw new TypeError('A normalized interest topic is malformed');
  const key=topicKey(label,category);if(seen.has(key))continue;seen.add(key);
  normalized.push({...topic,id:byKey.get(key)||id,label,category});
 }
 const additions=normalized.filter(topic=>!byKey.has(topicKey(topic.label,topic.category))).length;
 if(stored.length+additions>200)throw capacityError('Interest topic catalog can contain at most 200 topics');
 return normalized;
}

export function interestTopicStatements(db,owner,topics,guard){
 const safeOwner=String(owner||''),serialized=guard?.serializedInterests;
 if(!safeOwner||typeof serialized!=='string')throw new TypeError('owner and serialized interest guard are required');
 const seen=new Set(),statements=[],input=Array.isArray(topics)?topics:[];
 if(input.length>40)throw new RangeError('At most 40 interest topics can be stored at once');
 for(const topic of input){
  const id=typeof topic?.id==='string'?topic.id.trim():'',label=cleanText(topic?.label,60),category=cleanCategory(topic?.category);
  if(!id||id.length>100||!label)throw new TypeError('A normalized interest topic is malformed');const key=topicKey(label,category);if(seen.has(key))continue;seen.add(key);
  const sourceKey=typeof guard?.youtubeSummary==='string'?'youtube_summary':typeof guard?.linkedinSummary==='string'?'linkedin_summary':null,sourceValue=sourceKey==='youtube_summary'?guard.youtubeSummary:guard.linkedinSummary;
  const sql=`INSERT INTO interest_topics(id,owner,canonical_key,label,category,created) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM profiles WHERE owner=? AND interests=?)${sourceKey?' AND EXISTS (SELECT 1 FROM source_syncs WHERE owner=? AND '+sourceKey+'=?)':''} ON CONFLICT(owner,canonical_key) DO UPDATE SET label=excluded.label,category=excluded.category`;
  statements.push(db.prepare(sql).bind(id,safeOwner,key,label,category,new Date().toISOString(),safeOwner,serialized,...(sourceKey?[safeOwner,sourceValue]:[])));
 }
 return statements;
}

export async function normalizeInterestRecords(records,existingTopics,{embedTexts,generateTopics,signal,maxTopics=5}={}){
 if(typeof embedTexts!=='function'||typeof generateTopics!=='function')throw new TypeError('embedding and topic generation providers are required');
 const limit=Math.max(1,Math.min(40,Number.isFinite(maxTopics)?Math.floor(maxTopics):5));
 const source=[],sourceIds=new Set();
 for(const row of Array.isArray(records)?records.slice(0,40):[]){
  const id=typeof row?.id==='string'?row.id.trim():'',label=cleanText(row?.label,120),category=cleanCategory(row?.category,true),evidence=cleanText(row?.evidence,500),url=typeof row?.url==='string'&&row.url.length<=500&&/^https:\/\//i.test(row.url)?row.url:undefined;
  if(!id||id.length>100||sourceIds.has(id)||!label||(row?.evidenceOnly===true&&!evidence))continue;sourceIds.add(id);source.push({id,label,category,evidence,...(row?.evidenceOnly===true?{evidenceOnly:true}:{}),...(url?{url}:{})});
 }
 if(!source.length)return {interests:[],topics:[],stats:{reused:0,created:0,rejected:0}};
 const catalog=[],catalogKeys=new Set(),catalogIds=new Set(),blockedKeys=new Set();
 for(const topic of Array.isArray(existingTopics)?existingTopics.slice(0,200):[]){
  const id=typeof topic?.id==='string'?topic.id.trim():'',label=cleanText(topic?.label,60),category=cleanCategory(topic?.category);if(!id||!label)continue;
  const key=topicKey(label,category);if(topic?.avoid===true){blockedKeys.add(key);continue;}if(catalogIds.has(id)||catalogKeys.has(key))continue;catalogIds.add(id);catalogKeys.add(key);catalog.push({id,label,category});
 }
 abort(signal);
 const initialTexts=[...source.map(sourceEmbeddingText),...catalog.map(topic=>`${topic.category} ${topic.label}`)],initial=await embeddings(embedTexts,initialTexts,signal),sourceVectors=initial.slice(0,source.length),catalogVectors=initial.slice(source.length);
 const unmatched=[],assignments=new Map(),represented=new Set();
 const assign=(topic,record,kind)=>{
  const key=topicKey(topic.label,topic.category);let assignment=assignments.get(key);
  if(!assignment){if(assignments.size>=limit)return false;assignment={topic,records:[],kind};assignments.set(key,assignment);}
  if(!assignment.records.some(item=>item.id===record.id))assignment.records.push(record);represented.add(record.id);return true;
 };
 for(let index=0;index<source.length;index++){
  let best=-1,bestScore=-1;
  for(let topicIndex=0;topicIndex<catalog.length;topicIndex++){
   if(source[index].category&&source[index].category!==catalog[topicIndex].category)continue;
   const score=cosine(sourceVectors[index],catalogVectors[topicIndex]);if(score>bestScore){best=topicIndex;bestScore=score;}
  }
  if(best>=0&&bestScore>=MATCH_THRESHOLD)assign(catalog[best],source[index],'reused');
  else unmatched.push({record:source[index],vector:sourceVectors[index]});
 }
 const finish=()=>{
  const selected=[...assignments.values()],topics=selected.map(item=>item.topic),interests=selected.map(({topic,records})=>{
   const evidence=[...new Set(records.map(sourceEvidence))].join(' | ').slice(0,500),url=records.find(record=>record.url)?.url;
   return {label:topic.label,category:topic.category,topicId:topic.id,evidence,...(url?{url}:{})};
  });
  return {interests,topics,stats:{reused:selected.filter(item=>item.kind==='reused').length,created:selected.filter(item=>item.kind==='created').length,rejected:source.length-represented.size}};
 };
 if(!unmatched.length)return finish();
 abort(signal);const generated=await generateTopics(unmatched.map(item=>item.record),signal);abort(signal);
 if(!Array.isArray(generated))throw new Error('Gemini topic response is malformed');
 const candidates=[];
 for(const value of generated.slice(0,40)){
  const label=cleanText(value?.label,60),category=cleanCategory(value?.category,true),refs=value?.refs,validRefs=Array.isArray(refs)&&refs.length>0&&refs.every(id=>typeof id==='string'&&sourceIds.has(id)&&unmatched.some(item=>item.record.id===id))&&new Set(refs).size===refs.length;
  if(!label||!category||!validGeneratedLabel(label,category)||blockedKeys.has(topicKey(label,category))||!validRefs)continue;
  candidates.push({label,category,refs});
 }
 if(!candidates.length)return finish();
 const generatedVectors=await embeddings(embedTexts,candidates.map(topic=>`${topic.category} ${topic.label}`),signal,sourceVectors[0].length),accepted=[];
 for(let index=0;index<candidates.length;index++){
 const candidate=candidates[index],refs=candidate.refs.filter(id=>{
   const position=source.findIndex(row=>row.id===id);if(position<0)return false;const record=source[position];return cosine(generatedVectors[index],sourceVectors[position])>=MATCH_THRESHOLD||(record.evidenceOnly===true&&evidenceContainsLabel(candidate.label,record.evidence));
  });
  if(!refs.length)continue;accepted.push({...candidate,refs,vector:generatedVectors[index]});
 }
 const mintedByKey=new Map();
 for(const candidate of accepted){
  let topic=null,best=-1,bestScore=-1;
  for(let index=0;index<catalog.length;index++){
   if(candidate.category!==catalog[index].category)continue;const score=cosine(candidate.vector,catalogVectors[index]);if(score>bestScore){best=index;bestScore=score;}
  }
  let kind='reused';
  if(best>=0&&bestScore>=MATCH_THRESHOLD)topic=catalog[best];
  else{
   kind='created';const key=topicKey(candidate.label,candidate.category),minted=[...mintedByKey.values()];topic=mintedByKey.get(key)?.topic;
   if(!topic){const similar=minted.find(item=>item.topic.category===candidate.category&&cosine(item.vector,candidate.vector)>=MATCH_THRESHOLD);topic=similar?.topic;}
   if(!topic){topic={id:crypto.randomUUID(),label:candidate.label,category:candidate.category};mintedByKey.set(key,{topic,vector:candidate.vector});}
  }
  for(const ref of candidate.refs){
   const record=source.find(row=>row.id===ref);if(record)assign(topic,record,kind);
  }
 }
 return finish();
}
