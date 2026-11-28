import {invoke} from '@tauri-apps/api/core';

const delay=(ms:number)=>new Promise(done=>setTimeout(done,ms));
const frame=()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
const query=(s:string)=>document.querySelector<HTMLElement>(s);
const until=async<T>(what:string,fn:()=>T,ms=15_000):Promise<NonNullable<T>>=>{
  const end=performance.now()+ms;
  while(performance.now()<end){const v=fn();if(v)return v;await delay(55);}
  throw new Error('Timed out: '+what);
};
const probe=<T>(operation:string,data?:unknown)=>invoke<T>('renderer_probe',{operation,data});
const rpc=<T>(action:string)=>invoke<T>('manager_request',{request:{action}});
type Task={action:string,status:string,id:string,finishedAt?:string};
const checks=async()=>{const r=await rpc<{tasks:Task[]}>('list_tasks');return r.tasks.filter(t=>t.action==='check_now');};
const btn='button[aria-label="检查本地与 GitHub 变化"]';
const tap=async(s:string)=>{const el=await until(s,()=>query(s));el.click();await frame();};
const row='tr[data-skill-id="perf-skill-0000"]';
const receiptIds:string[]=[];
async function check(){
  const before=new Set((await checks()).map(t=>t.id));
  const button=await until('enabled check',()=>{const e=document.querySelector<HTMLButtonElement>(btn);return e&&!e.disabled?e:null;});
  button.click();
  await until('native check started',()=>document.querySelector<HTMLButtonElement>(btn)?.disabled);
  await until('native check completed',()=>!document.querySelector<HTMLButtonElement>(btn)?.disabled,70_000);
  const fresh=(await checks()).filter(t=>!before.has(t.id));
  if(fresh.length!==1||fresh[0].status!=='succeeded'||!fresh[0].finishedAt)throw new Error('Missing unique succeeded check receipt');
  receiptIds.push(fresh[0].id);
}
async function navigate(){
  const open=await until('Skill 0000',()=>[...document.querySelectorAll<HTMLButtonElement>(row+' button')].find(el=>el.textContent?.trim()==='Perf Skill 0000'));open.click();
  const article='.workspace-page[data-pane-kind="detail"] article[data-outline-document]';
  await until('document',()=>query(article+' h1')?.textContent==='Perf Skill 0000');
  await tap('[data-workspace-tab="home"] .workspace-tab-select');
  await until('document hidden',()=>query(article)?.closest<HTMLElement>('.workspace-page')?.hidden);
  await tap('[data-workspace-tab][data-home="false"] .workspace-tab-select');
  await until('document visible',()=>{const a=query(article);return a&&!a.closest<HTMLElement>('.workspace-page')?.hidden;});
  await tap('button[aria-label="关闭 Perf Skill 0000"]');await until('document closed',()=>!query(article)&&!!query(row));
}
async function quit(){
  await tap('button[aria-label="工作区快捷键"]');
  (await until('normal quit',()=>[...document.querySelectorAll<HTMLButtonElement>('.workspace-help button')].find(b=>b.textContent==='完全退出管理器'))).click();
}
export async function run(){
 const {variant,pid}=await probe<{variant:string,pid:number}>('start');
 const start=performance.now();
 let cycle=0;
 try{
   await tap('button.nav-item[aria-label="Skills"]');await until('prepared 1000 skills',()=>query('button.nav-item[aria-label="Skills"] .nav-count')?.textContent==='1000',40_000);
   await check();await navigate();await navigate();
   const sample=async(stage:string,collect:boolean)=>{
     await delay(350);await frame();const heapBefore=await probe('heap'),domBefore=await probe('dom');
     if(collect){await probe('collect');await delay(120);await probe('collect');}
     const heap=collect?await probe('heap'):heapBefore,dom=collect?await probe('dom'):domBefore;
     const invalid=(!Array.isArray(receiptIds)||document.querySelectorAll('[data-workspace-tab]').length!==1||document.querySelector('.check-error')||query('.workspace-page[data-pane-kind="detail"]'));
     if(invalid)throw new Error('Unexpected terminal workspace');
     await probe('report',{stage,variant,pid,cycle,time:new Date().toISOString(),elapsedMs:performance.now()-start,heapBefore,domBefore,heap,dom,collect,receipts:[...receiptIds],userAgent:navigator.userAgent,visible:document.visibilityState,tabs:document.querySelectorAll('[data-workspace-tab]').length,liveDOMElements:document.getElementsByTagName('*').length});
     await delay(2200);
   };
   await sample('baseline',true);
   for(let i=1;i<=6;i++){
     cycle=i;const t=performance.now();
     if(variant==='check'&&i%2===1)await check();
     await navigate();
     await delay(Math.max(0,14_000-(performance.now()-t)));
     if(i%2===0)await sample('pair'+i,false);
   }
   await sample('final',true);
 }catch(e){await probe('report',{stage:'failure',variant,pid,cycle,time:new Date().toISOString(),reason:String(e),receipts:receiptIds});}
 finally{await quit();}
}
