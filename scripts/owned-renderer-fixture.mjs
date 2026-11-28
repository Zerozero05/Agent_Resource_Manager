import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createPerformanceFixture} from './performance-fixture.mjs';
const root='D:/arm-renderer-probe-6239',phase=process.argv[2],variant=process.argv[3];
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.ok(['navigation','check'].includes(variant));
const file=join(root,variant,'dataset.json');
const dataset=phase==='prepare'?await createPerformanceFixture(root,variant,100):JSON.parse(await readFile(file));
assert.equal(dataset.syntheticOnly,true);
const db=new DatabaseSync(dataset.dbPath,{readOnly:true}),state=JSON.parse(db.prepare('select payload from app_state where id=1').get().payload);
const tools=db.prepare('select id,revision,payload from resource_catalog order by id').all();
assert.equal(state.skills.length,1000);assert.equal(tools.length,100);assert.equal(state.sources.length,0);assert.equal(state.connections.length,0);
const fixed={skills:[],tools,categories:state.settings.categories};
const sha=v=>createHash('sha256').update(v).digest('hex');
for(const skill of state.skills){const path=join(skill.localPath,'SKILL.md'); assert.match(skill.id,/^perf-skill-\d{4}$/);fixed.skills.push([skill.id,skill.localPath,skill.favorite,skill.categoryId,skill.version,sha(await readFile(path))]);}
const hash=sha(JSON.stringify(fixed));
if(phase==='prepare'){await writeFile(join(dataset.root,'before.txt'),hash,{flag:'wx'});}
else{
 assert.equal(phase,'verify');assert.equal(await readFile(join(dataset.root,'before.txt'),'utf8'),hash);
 const tasks=db.prepare("select json_extract(payload,'$.id') id,json_extract(payload,'$.status') status from task_history where json_extract(payload,'$.action')='check_now' order by id").all();
 const final=JSON.parse(await readFile(join(dataset.root,'probe-final.json')));
 assert.equal(tasks.length,variant==='navigation'?1:4);assert.ok(tasks.every(t=>t.status==='succeeded'));
 assert.deepEqual(tasks.map(t=>t.id),final.receipts.toSorted());assert.equal(state.checkMode,'manual');
 await writeFile(join(dataset.root,'db-readback.json'),JSON.stringify({syntheticOnly:true,protectedFieldsAndRuntimeSha256:hash,fixtureFingerprint:dataset.dataFingerprint,checkedSkillCount:fixed.skills.length,checkedToolCount:tools.length,tasks,mode:state.checkMode},null,2),{flag:'wx'});
}
db.close();
