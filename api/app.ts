import {api} from '../backend/api.mjs';
import {createTursoDBFromEnv,TursoDatabaseError} from '../backend/turso-db.mjs';
import {optimizeGroups} from '../backend/vercel-optimizer.mjs';
import {validateBridgeTopics,embedInterestTexts,semanticPairs} from '../backend/semantic.mjs';
import type {Profile,Match} from '../shared/matching.ts';

const unavailable=()=>Response.json({error:'저장소 연결 설정이 아직 완료되지 않았어요.'},{status:503,headers:{'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});
const preflight=()=>new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'}});

export async function handler(request:Request){
 if(request.method==='OPTIONS')return preflight();
 let DB;
 try{DB=createTursoDBFromEnv(process.env);}catch(error){if(error instanceof TursoDatabaseError){console.error('database configuration unavailable');return unavailable();}throw error;}
 const solverEnv={...process.env,GROUP_SOLVER_URL:process.env.GROUP_SOLVER_URL||new URL('/api/solver',request.url).href};
 try{return await api(request,{DB,validateBridgeTopics,embedInterestTexts,semanticPairs,GEMINI_API_KEY:process.env.GEMINI_API_KEY,GEMINI_MODEL:process.env.GEMINI_MODEL,BRIGHTDATA_API_KEY:process.env.BRIGHTDATA_API_KEY,BRIGHTDATA_LINKEDIN_DATASET_ID:process.env.BRIGHTDATA_LINKEDIN_DATASET_ID,LINKEDIN_GEMINI_MODEL:process.env.LINKEDIN_GEMINI_MODEL,optimizeGroups:(people:Profile[],matches:Match[],size:number,signal?:AbortSignal)=>optimizeGroups(people,matches,size,solverEnv,signal),OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENAI_MODEL:process.env.OPENAI_MODEL,YOUTUBE_CLIENT_ID:process.env.YOUTUBE_CLIENT_ID,YOUTUBE_CLIENT_SECRET:process.env.YOUTUBE_CLIENT_SECRET,YOUTUBE_REDIRECT_URI:process.env.YOUTUBE_REDIRECT_URI});}
 catch(error){console.error('vercel api failed',error instanceof Error?error.name:'unknown');return Response.json({error:'처리하지 못했어요. 잠시 후 다시 시도해주세요.'},{status:503,headers:{'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}});}
}

export default {fetch:handler};
