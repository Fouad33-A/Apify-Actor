#!/usr/bin/env node
// Public Hugging Face dataset viewer diagnostic. No paid API or Apify calls.
// This is an exploratory sample, NOT permission to reuse data commercially.
import { mkdirSync, writeFileSync } from 'node:fs';
const dataset='Tikfly/tiktok-top-kol';
const base='https://datasets-server.huggingface.co';
const offsets=[0,1000,10000,100000,500000,900000];
const result={checkedAt:new Date().toISOString(),dataset,license:'unverified',samples:[],sampled:0,eligibleBySnapshot:0,uniqueEligibleHandles:0,sampleProfiles:[],warning:'Snapshot follower counts are not live. No median views, activity, or verified licensing assessment.'};
const handles=new Set();
for(const offset of offsets){
 const row={offset,status:null,returned:0,eligible:0,error:null};
 try{
  const url=base+'/rows?dataset='+encodeURIComponent(dataset)+'&config=default&split=train&offset='+offset+'&length=100';
  const response=await fetch(url,{signal:AbortSignal.timeout(16000),headers:{'User-Agent':'PublicDatasetDiagnostic/1.0'}});
  row.status=response.status;
  if(!response.ok)throw new Error('HTTP '+response.status);
  const body=await response.json();
  for(const item of body.rows??[]){
   row.returned++;
   const p=item.row??{};
   const followers=Number(p.follower_count);
   if(followers>=10000&&followers<=150000&&p.verified===false&&p.secret===false&&typeof p.unique_id==='string'){
    const h=p.unique_id.toLowerCase();
    if(/^(?=.{2,24}$)[a-z0-9._]+$/.test(h)&&!h.includes('..')&&!h.startsWith('.')&&!h.endsWith('.')){
      row.eligible++;handles.add(h);
    }
   }
  }
 }catch(e){row.error=String(e?.message??e).slice(0,180)}
 result.samples.push(row);result.sampled+=row.returned;result.eligibleBySnapshot+=row.eligible;
 console.log(JSON.stringify(row));
}
result.uniqueEligibleHandles=handles.size;
result.sampleProfiles=[...handles].slice(0,20).map(h=>'https://www.tiktok.com/@'+h);
mkdirSync('diagnostics',{recursive:true});
writeFileSync('diagnostics/free-dataset-discovery.json',JSON.stringify(result,null,2)+'\n');
console.log('FREE_DATASET_RESULT '+JSON.stringify(result));
