// Loaded only by the private demo copy; no production source or service is changed.
import {readFileSync,statSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
import {ReferenceAnythingRemote} from './host.js'
import {localLocatorId} from './local-locator.js'
assert(process.env.DSH_HOME?.includes('web-demos'), 'Fixtures require the isolated demo home')
const currentVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version
let upgraded=false
let generation=0
const mode=()=>{const path=new URL('../../mode.json',import.meta.url),next=statSync(path).mtimeMs;if(next!==generation){upgraded=false;generation=next}return JSON.parse(readFileSync(path,'utf8')).scene}
const agents=[{id:localLocatorId({source:'codex',path:'C:/demo/history/cache.jsonl',sessionId:'demo-cache'}),kind:'codex',label:'缓存策略设计',provider:'Codex',importStatus:'not-imported'},{id:localLocatorId({source:'claude',path:'C:/demo/history/api.jsonl',sessionId:'demo-api'}),kind:'claude-code',label:'接口重构方案',provider:'Claude Code',importStatus:'imported'}]
const health={version:'1.0.0',daemon:'demo',pluginInstalled:true,daemonRunning:false,extensionConnected:false,extensionState:'disconnected',opencliCompatible:true,daemonStale:false,connectivityOk:false,connectivityChecked:false,adapterCommandsReady:true,adapterCompatible:true,updateAvailable:false}
for(const [kind,label,provider] of [['omp','OMP 测试计划','oh-my-pi'],['copilot-vscode','Copilot 接口设计','Copilot VS Code'],['copilot-cli','Copilot 命令行排查','Copilot CLI'],['doubao','豆包本地缓存笔记','Doubao']])agents.push({id:localLocatorId({source:kind,path:`C:/demo/history/${kind}.json`,sessionId:`demo-${kind}`}),kind,label,provider,importStatus:'not-imported'})
Object.assign(ReferenceAnythingRemote.prototype,{
 async agentSearch(_agent,{query,limit,kind}){return agents.filter(row=>(!kind||row.kind===kind)&&(row.label.includes(query)||!query)).slice(0,limit)},
 async agentStats(){return [{agent:'codex',conversations:1,readable:true},{agent:'claude-code',conversations:1,readable:true}]},
 async chatImportStatus(){const upgrade=mode()==='chat-import-upgrade';if(!upgrade)upgraded=false;return {state:upgrade?(upgraded?'restart-required':'incompatible'):'ready',version:!upgrade||upgraded?'0.26.3':'0.25.0',missing:upgrade&&!upgraded?['resumeSummary']:[],canUpgrade:upgrade&&!upgraded}},
 async chatImportUpgradeInstall(){assert.equal(mode(),'chat-import-upgrade');await new Promise(r=>setTimeout(r,1400));upgraded=true;return this.chatImportStatus()},
 async quickHealth(){return health},async health(){return health},async profiles(){return []},async stats(){return []},
 async search({query,provider}){return [{uriId:'demo-chatgpt',provider:'chatgpt',title:'缓存失效策略'},{uriId:'demo-claude',provider:'claude',title:'缓存命中率优化'}].filter(row=>(!provider||row.provider===provider)&&row.title.includes(query)).map(row=>({...row,url:'https://example.invalid/demo',updatedAt:'2026-10-17T08:00:00Z',syncedAt:'2026-10-17T08:00:00Z',turnCount:2,partial:false,matchedVia:'title'}))},
 async updateStatus(){return {currentVersion,latestVersion:currentVersion,updateAvailable:false,checkedAt:Date.now()}},
 async checkUpdate(){return this.updateStatus()},
 async installUpdate(){throw Error('Real updates are disabled in the recording environment')},
 async installOpenCli(){throw Error('Installation disabled in demos')},
 async installAdapter(){throw Error('Installation disabled in demos')},
 async agentResume(){return '已确定缓存键、TTL 与主动失效方案。下一步实现缓存模块。'},
 async agentImport(agent){
  await new Promise(r=>setTimeout(r,900))
  const id='demo-import-'+randomUUID(),time=Date.now()
  await this.ctx.get('sessionController').create({sessionId:id,cwd:agent.session.header.cwd})
  const session=this.ctx.get('agents').get(id).session
  const message=(role,text)=>({role,id:randomUUID(),content:[{type:'text',text}],source:role==='user'?{kind:'user'}:{kind:'model',provider:'demo',model:'demo'}})
  const events=[{type:'turn/start',data:{turn:1}},{type:'step/start',data:{turn:1,step:1}},{type:'user/message',data:message('user','请帮我设计一个缓存策略。'),surfaceOp:'append'},{type:'assistant/message',data:{turn:1,step:1,message:message('assistant','采用缓存旁路模式：读取时先查缓存，未命中再查数据库；写入后使缓存失效，并设置 TTL。'),stream:[]},surfaceOp:'append'},{type:'step/end',data:{turn:1,step:1}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},{type:'session/title',data:{title:'缓存策略设计',messageSeqs:[],source:{kind:'user'}}}].map((event,i)=>({...event,seq:i,time:time+i}))
  for(const event of events)session.append(event.type,event.data,...(event.surfaceOp?[{surfaceOp:event.surfaceOp}]:[]))
  const workspace=await this.ctx.get('workspaceRegistry').create(agent.session.header.cwd)
  await workspace.attachSession(id)
  await new Promise(r=>setTimeout(r,350))
  return id
 }
})
