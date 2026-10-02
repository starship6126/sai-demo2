import {ensureProfileColumns} from './profile-migration.mjs';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {api} from './api.mjs';
import {semanticPairs,validateBridgeTopics,embedInterestTexts} from './semantic.mjs';
import {optimizeGroups} from './group-optimizer.mjs';
import {createDemoStore} from './demo-store.mjs';
import {createDemoApi} from './demo-api.mjs';
const demoApi=createDemoApi(createDemoStore(process.env.SAI_DEMO_DIR||'.data'));
const databasePath=process.env.SAI_DB_PATH||'.data/sai.sqlite';
fs.mkdirSync(path.dirname(databasePath),{recursive:true});const sqlite=new DatabaseSync(databasePath);sqlite.exec('PRAGMA foreign_keys=ON');
sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');

function prepare(sql){let args=[];const stmt=sqlite.prepare(sql);return{bind(...v){args=v;return this;},async first(){return stmt.get(...args)||null;},async all(){return{results:stmt.all(...args)};},async run(){return stmt.run(...args);}};}
const DB={prepare,async batch(stmts){sqlite.exec('BEGIN');try{const result=[];for(const s of stmts)result.push(await s.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
for(const name of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort()){if(!sqlite.prepare('SELECT name FROM local_migrations WHERE name=?').get(name)){if(name.startsWith('0001_'))await ensureProfileColumns(DB);sqlite.exec(fs.readFileSync('drizzle/'+name,'utf8'));sqlite.prepare('INSERT INTO local_migrations (name) VALUES (?)').run(name);}}
const server=createServer(async(req,res)=>{try{
const url=new URL(req.url,`http://${req.headers.host}`);if(url.pathname.startsWith('/api/')){let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16*1024*1024){res.writeHead(413);res.end('too large');return;}}
const request=new Request(url,{method:req.method,headers:req.headers,...(body?{body}: {})});let result;
if(url.pathname.startsWith('/api/demo/'))result=await demoApi(request);
else if(url.pathname==='/api/app')result=await api(request,{DB,OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENAI_MODEL:process.env.OPENAI_MODEL,OLLAMA_URL:process.env.OLLAMA_URL,OLLAMA_MODEL:process.env.OLLAMA_MODEL,YOUTUBE_CLIENT_ID:process.env.YOUTUBE_CLIENT_ID,YOUTUBE_CLIENT_SECRET:process.env.YOUTUBE_CLIENT_SECRET,YOUTUBE_REDIRECT_URI:process.env.YOUTUBE_REDIRECT_URI||url.origin+'/api/app?action=youtubeCallback',semanticPairs,validateBridgeTopics,embedInterestTexts,GEMINI_API_KEY:process.env.GEMINI_API_KEY,GEMINI_MODEL:process.env.GEMINI_MODEL,BRIGHTDATA_API_KEY:process.env.BRIGHTDATA_API_KEY,BRIGHTDATA_LINKEDIN_DATASET_ID:process.env.BRIGHTDATA_LINKEDIN_DATASET_ID,LINKEDIN_GEMINI_MODEL:process.env.LINKEDIN_GEMINI_MODEL,optimizeGroups});
else result=Response.json({error:'not found'},{status:404});
res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;}
const root=path.resolve('dist/client'),file=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(403);res.end();return;}const chosen=fs.existsSync(file)&&fs.statSync(file).isFile()?file:path.join(root,'index.html');if(!fs.existsSync(chosen)){res.writeHead(200,{'Content-Type':'text/plain;charset=utf-8'});res.end('사이 API 준비 완료. 휴대폰에서 Expo 앱을 실행하세요.');return;}
const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf','.json':'application/json'};res.writeHead(200,{'Content-Type':types[path.extname(chosen)]||'application/octet-stream'});fs.createReadStream(chosen).pipe(res);
}catch(e){console.error(e);res.writeHead(500);res.end('서버 오류');}});
const port=Number(process.env.SAI_PORT||process.env.PORT||8788),host=process.env.HOST||'127.0.0.1';
server.listen(port,host,()=>console.log(`사이 Demo + 서비스 http://${host}:${port}`));
