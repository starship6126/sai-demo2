import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

const projectSolver=resolve('.data/solver-env',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const solverPython=process.env.SAI_SOLVER_PYTHON||(existsSync(projectSolver)?projectSolver:'');
const testEnv={...process.env,...(solverPython?{SAI_SOLVER_PYTHON:solverPython,SAI_PYTHON:process.env.SAI_PYTHON||solverPython}:{})};
const tests=['qwen-runtime','vercel-bridge-validator','bridge-topics','bridge-discovery','solver-service','bridge-api','bridge-budget','auth','profile-conflict','account-ui','preferences','taste-extraction','grouping','service-presentation','avatar','onboarding-links','youtube-interest-extraction','youtube-import','youtube-ui','interest-topics','source-ingestion','linkedin-preview','linkedin-import','interest-profile','optimizer','optimizer-remote','vercel-solver','vercel-api','demo-data','demo-api','default-demo'];
for(const name of tests){
 const result=spawnSync(process.execPath,[`backend/${name}-smoke.mjs`],{stdio:'inherit',env:testEnv});
 if(result.status!==0)process.exit(result.status||1);
}
