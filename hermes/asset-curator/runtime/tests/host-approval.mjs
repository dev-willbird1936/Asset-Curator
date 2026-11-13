import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const tmp=await mkdtemp(path.join(os.tmpdir(),'curator-approval-'));
const home=path.join(tmp,'home'), downloads=path.join(home,'Downloads'), workspace=path.join(tmp,'project');
await Promise.all([mkdir(downloads,{recursive:true}),mkdir(workspace)]);
const source=path.join(downloads,'icon.svg'); await writeFile(source,'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
const common={sourcePath:source,licenseName:'CC0',formats:['svg'],request:'icon',attributionRequired:false};
let clients=[];
async function connect(mode, answer, capability=true) {
 const profile=await mkdtemp(path.join(tmp,'profile-')), prompts=[];
 const client=new Client({name:'approval-test',version:'1'},{capabilities:capability?{elicitation:{form:{}}}:{}}); clients.push(client);
 if(capability) client.setRequestHandler(ElicitRequestSchema,async req=>{prompts.push(req.params.message);return {action:answer,content:answer==='accept'?{}:undefined};});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('../launch.mjs')],env:{...process.env,HOME:home,USERPROFILE:home,PLUGIN_DATA:profile,ASSET_GRABBER_ACCESS_MODE:mode,ASSET_GRABBER_PROJECTS_FOLDER:workspace},stderr:'pipe'}));
 await client.callTool({name:'configure_preferences',arguments:{licensePolicy:'safe',browserEnabled:false,acquisitionMode:'both'}});
 return {client,prompts};
}
try {
 for(const decision of ['decline','cancel']) {
  const {client,prompts}=await connect('no',decision);
  const result=await client.callTool({name:'prepare_existing_asset',arguments:{...common,approved:true,outputDir:path.join(workspace,decision)}}); assert.equal(result.isError,true); assert.equal(prompts.length,1); assert.match(prompts[0],/approve ONE action/);
  await assert.rejects(readFile(path.join(workspace,decision,'local','icon','ready','icon.svg')));
 }
 const missing=await connect('no','accept',false); assert.equal((await missing.client.callTool({name:'prepare_existing_asset',arguments:common})).isError,true);
 const accepted=await connect('no','accept');
 const dest=path.join(workspace,'one-off');
 const ok=await accepted.client.callTool({name:'prepare_existing_asset',arguments:{...common,outputDir:dest}}); assert.notEqual(ok.isError,true,JSON.stringify(ok)); assert.equal(accepted.prompts.length,1); assert.match(accepted.prompts[0],/saved mode stays no/i); assert.ok(accepted.prompts[0].includes(dest));
 assert.ok((await readFile(path.join(ok.structuredContent.paths.ready,'icon.svg'),'utf8')).startsWith('<svg'));
 const setup=await accepted.client.callTool({name:'get_setup',arguments:{}}); assert.equal(setup.structuredContent.preferences.accessMode,'no');
 await accepted.client.callTool({name:'prepare_existing_asset',arguments:{...common,request:'second icon',outputDir:path.join(workspace,'another')}}); assert.equal(accepted.prompts.length,2,'approval must not persist');
 // Cancellation while a human prompt is open must not permit a late accept.
 const pending=await connect('no','accept'); let announce,release;
 const promptStarted=new Promise(r=>announce=r), lateAnswer=new Promise(r=>release=r);
 pending.client.setRequestHandler(ElicitRequestSchema,async()=>{announce();await lateAnswer;return {action:'accept',content:{}};});
 const controller=new AbortController(), cancelledDest=path.join(workspace,'cancelled');
 const call=pending.client.callTool({name:'prepare_existing_asset',arguments:{...common,outputDir:cancelledDest}},undefined,{signal:controller.signal});
 const rejectedCall=assert.rejects(call); await promptStarted; controller.abort(); await rejectedCall; release();
 await new Promise(r=>setTimeout(r,100)); await assert.rejects(readFile(path.join(cancelledDest,'local','icon','ready','icon.svg')));
 for(const mode of ['full','hermes']) {
  const {client,prompts}=await connect(mode,'decline');
  const result=await client.callTool({name:'prepare_existing_asset',arguments:{...common,outputDir:path.join(tmp,mode)}}); assert.notEqual(result.isError,true,JSON.stringify(result)); assert.equal(prompts.length,0);
 }
 const project=await connect('project','decline');
 const inside=await project.client.callTool({name:'prepare_existing_asset',arguments:{...common,outputDir:path.join(workspace,'custom-assets')}}); assert.notEqual(inside.isError,true); assert.equal(project.prompts.length,0);
 const outside=await project.client.callTool({name:'prepare_existing_asset',arguments:{...common,outputDir:path.join(tmp,'outside')}}); assert.equal(outside.isError,true); assert.equal(project.prompts.length,1);
 console.log('PASS: host elicitation accept/decline/cancel/missing, forged approval ignored, exact destination, one-off scope, mode unchanged, full/hermes host-managed, project workspace limits');
} finally {for(const c of clients) await c.close();await rm(tmp,{recursive:true,force:true});}
