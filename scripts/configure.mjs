#!/usr/bin/env node
import {readFile,writeFile,mkdir,cp,readdir,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {parseArgs} from 'node:util';
const root=resolve(dirname(fileURLToPath(import.meta.url)), "..");
const {values}=parseArgs({options:{app:{type:'string'},output:{type:'string'},help:{type:'boolean'}}});
if(values.help){console.log('npm run configure -- [--app "/Applications/Adobe Illustrator 2026/Adobe Illustrator.app"] [--output "/目标目录"]\n只生成本机配置及配套 skill，不修改 Codex 设置，不操作 Illustrator。');process.exit(0);}
if(process.platform!=='darwin')throw new Error('此项目的配置生成流程仅验证 macOS。');
if(Number(process.versions.node.split('.')[0])<22)throw new Error('需要 Node.js 22 或更高版本。');
async function isDirectory(path){try{return (await stat(path)).isDirectory();}catch{return false;}}
let app=values.app?resolve(values.app):null;
if(!app){
 const found=[];
 for(const base of ['/Applications',join(homedir(),'Applications')]){
  let entries=[];try{entries=await readdir(base,{withFileTypes:true});}catch{}
  for(const entry of entries){
   if(!/^Adobe Illustrator(?:\s.*)?$/.test(entry.name))continue;
   for(const possible of [join(base,entry.name,'Adobe Illustrator.app'),join(base,entry.name)]){
    if(possible.endsWith('.app')&&await isDirectory(possible)&&!found.includes(possible))found.push(possible);
   }
  }
 }
 if(found.length!==1)throw new Error(found.length?'找到多个 Illustrator 版本，请用 --app 明确选择：\n'+found.join('\n'):'未找到 Illustrator。安装后重试，或用 --app 指定实际 .app 路径。');
 app=found[0];
}
if(!app.endsWith('.app')||!await isDirectory(app))throw new Error('Illustrator 路径必须指向现有的 .app 应用。');
const output=resolve(values.output||join(root,'generated'));
const state=join(root,'var');
const info=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const binding={command:process.execPath,args:[join(root,'dist','index.js')],env:{ILLUSTRATOR_MCP_BACKGROUND:'1',ILLUSTRATOR_MCP_STATE_DIR:state,ILLUSTRATOR_MCP_APP_PATH:app,ILLUSTRATOR_MCP_KEEP_AWAKE:'1'}};
await mkdir(output,{recursive:true});
const config=['# 仅添加/替换这一个 MCP 条目；保留其他个人设置。','[mcp_servers.illustrator-mcp-server]',`command = ${JSON.stringify(binding.command)}`,`args = ${JSON.stringify(binding.args)}`,'enabled = true','tool_timeout_sec = 120','','[mcp_servers.illustrator-mcp-server.env]',...Object.entries(binding.env).map(([key,value])=>`${key} = ${JSON.stringify(value)}`),''].join('\n');
await writeFile(join(output,'codex-config.toml'),config);
await writeFile(join(output,'mcp-config.json'),JSON.stringify({mcpServers:{'illustrator-mcp-server':binding}},null,2)+'\n');
const skill=join(output,'illustrator-batch-cards');
await cp(join(root,'skill-template','illustrator-batch-cards'),skill,{recursive:true});
const policy=join(skill,'references','script-execution.md');
const source=await readFile(policy,'utf8');
if(!source.includes('@@MCP_STATE_DIRECTORY@@'))throw new Error('技能模板缺少路径占位符，请检查项目完整性。');
await writeFile(policy,source.replaceAll('@@MCP_STATE_DIRECTORY@@',state));
await writeFile(join(output,'安装到Codex的提示词.txt'),`请安装此本地 Illustrator MCP 项目：\n\n1. 合并 ${join(output,'codex-config.toml')} 中的 illustrator-mcp-server 配置，保留其他个人设置；如已有同名条目，先备份后替换，不要重复添加。\n2. 停用旧 illustrator-bridge；如发现其他同类 Illustrator MCP，先核实用途，避免混用。\n3. 将 ${skill} 安装为 illustrator-batch-cards skill；已有技能先备份，再比较和更新。技能只能调用统一 MCP，每次检查版本、后台状态和任务占用，不回退到其他 MCP 或电脑。\n4. 重新连接 MCP，调用 get_runtime_status，确认 version=${info.version}、revision=${info.localRevision}、background=true、computer_use_fallback=false、state_directory=${state}，并确认 execution 和 batch 为空。\n5. 本次只安装和核验服务，不自动创建或修改 Illustrator 文档。\n`);
console.log('已生成本机配置和 skill：\n'+output+'\n\n尚未修改 Codex 设置，也未操作 Illustrator。\n把 generated/安装到Codex的提示词.txt 发给目标电脑上的 Codex，即可按实际路径安装。\n文件夹移动后，需重新运行本脚本并更新配置。');
