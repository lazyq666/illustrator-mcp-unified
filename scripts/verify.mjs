#!/usr/bin/env node
// Only queries MCP metadata. Does not send a script or document operation to Illustrator.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), "..");
const info=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const state=await mkdtemp(join(tmpdir(),'illustrator-export-check-'));
const client=new Client({name:'illustrator-export-verifier',version:'1'});
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'dist/index.js')],env:{...process.env,ILLUSTRATOR_MCP_BACKGROUND:'1',ILLUSTRATOR_MCP_STATE_DIR:state}}));
 const {tools}=await client.listTools();
 const raw=await client.callTool({name:'get_runtime_status',arguments:{}});
 if(raw.isError)throw new Error(JSON.stringify(raw));
 const status=JSON.parse(raw.content.find(x=>x.type==='text').text);
 if(status.version!==info.version||status.revision!==info.localRevision||status.background!==true||status.computer_use_fallback!==false||status.state_directory!==state||status.execution!==null||status.batch!==null)throw new Error('导出包状态与声明不一致');
 if(tools.length!==77)throw new Error('工具数量应为 77，实际为 '+tools.length);
 for(const required of ['run_script','batch_cards','get_batch_status','validate_cards','import_pdf_as_paths','replace_masked_image','recover_execution'])if(!tools.some(t=>t.name===required))throw new Error('缺少工具：'+required);
 await import('../dist/cards/native.js');
 console.log(JSON.stringify({passed:true,version:status.version,revision:status.revision,tools:tools.length,background:true,computer_use_fallback:false,native_illustrator_operations:0},null,2));
}finally{await client.close();await rm(state,{recursive:true,force:true});}
