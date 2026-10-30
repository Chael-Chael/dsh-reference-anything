import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, symlink, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ReferenceRuntime from '../src/index.ts'
import * as mention from '../src/reference.ts'
import * as tool from '../src/tool.ts'
import { localLocatorId, type LocalLocator } from '../src/local-locator.ts'
import { formatReferenceMention, parseReferenceText } from '../src/uri.ts'
import { loadLocalReference, renderLocalPreview, buildLocalPreview, readLocalPage, selectLocalRows, localBytes, type LocalDocument, type LocalFrom } from '../src/local-reference.ts'
import { readLocalTool } from '../src/local-reference-tools.ts'

let mentionFiber: { dispose(): Promise<void> }
let toolFiber: { dispose(): Promise<void> }
let root: string, ctx: Context, locator: LocalLocator, agent: Agent, raw: string
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDxkAAAAASUVORK5CYII='
const message=(role:string,text:string, image=false)=>({type:'response_item',payload:{type:'message',role,content:[{type:role==='user'?'input_text':'output_text',text},...(image?[{type:'input_image',image_url:`data:image/png;base64,${png}`}]:[])]}})
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'local-reference-'))
 locator={source:'codex',path:join(root,'sample.jsonl'),sessionId:'sample'}
 raw=[{type:'session_meta',payload:{id:'sample'}},message('user','What color is this?',true),{type:'response_item',payload:{type:'function_call',call_id:'c1',name:'read_file',arguments:'{"file":"test"}'}},{type:'response_item',payload:{type:'function_call_output',call_id:'c1',output:'secret tool output'}},message('assistant','It is red.')].map(row=>JSON.stringify(row)).join('\n')+'\n'
 await writeFile(locator.path,raw)
 ctx=new Context()
 await ctx.plugin(ReferenceRuntime,{})
 ctx.references.registerSource({id:'local-agent',requiresGrant:true,available:async()=>true,list:async()=>[{ref:{source:'local-agent',id:localLocatorId(locator)},label:'Color'}],read:async()=>{throw Error('legacy read must not run')}})
 ctx.provide('referenceLocalAgents',{referenceDirectory:async()=>({items:[{ref:{source:'local-agent',id:localLocatorId(locator)},label:'Color',updatedAt:1}],warnings:[]}),discoveryPolicy:()=>({roots:[{kind:'codex',path:root}],scope:'all'})})
 await ctx.plugin(SystemPrompt,{})
 await ctx.plugin(ToolRuntime,{})
 toolFiber=await ctx.plugin(tool,{maxReadTurns:50})
 mentionFiber=await ctx.plugin(mention,{})
 ctx.provide('llm',{resolveModelInfo:async()=>({context:{contextWindow:100000}})})
 agent={session:Session.create(SessionId('local-test')),options:{provider:'test',model:'test'}} as Agent
})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
const text=(result:{content:readonly {type:string;text?:string}[]})=>result.content.filter(row=>row.type==='text').map(row=>row.text).join('\n')
const grant=()=>ctx.references.grant(String(agent.session.id),{source:'local-agent',id:localLocatorId(locator)})
const call=(name:string,args:unknown)=>ctx.tools.execute({agent,signal:new AbortController().signal,callId:'t' as never,name,arguments:JSON.parse(JSON.stringify(args))})

const unwrap=(result: Awaited<ReturnType<typeof call>>):any=>{expect(result.isError,text(result)).not.toBe(true);return result.value}
const initial=async()=>unwrap(await call('reference_read',{ref:locator}))
const prompt=(target=locator,label='Color')=>createUserMessage({source:{kind:'user'},content:[{type:'text',text:formatReferenceMention({source:'local-agent',id:localLocatorId(target)},label)+' Keep this question.'}]})
const step=async(messages:import('@deepseek-ai/dsh-llm').UserMessage[]=[prompt()])=>{
 const result=await ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages}))
 if(result.kind!=='enter')throw Error('rejected')
 return result.messages
}
const preview=(message:any)=>JSON.parse(text(message).split('<references>')[1]!.split('</references>')[0]!)

it('reads 118 messages continuously with versioned next and a single canonical body',async()=>{
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},...Array.from({length:118},(_,i)=>message('user',`message ${i+1}`))].map(row=>JSON.stringify(row)).join('\n'))
 const ids:number[]=[];let from,revision
 do{
  const result=await call('reference_read',{ref:locator,revision,from,maxItems:50})
  const page=unwrap(result);ids.push(...page.items.map((i:any)=>i.messageId));from=page.next;revision=page.revision
  expect(Object.keys(page).sort()).toEqual(['items','next','revision'])
  expect(preview(result)).toEqual(page)
 }while(from)
 expect(ids).toEqual(Array.from({length:118},(_,i)=>i+1))
 expect((await initial()).items[0].messageId).toBe(1)
})

it('rechecks source settings for read, search, images, listing and hook without needing grants',async()=>{
 const settings={enabledAgents:['codex'],picker:{agents:{enabled:true}}}
 ctx.provide('referenceChatHistory',{getSettings:()=>settings,store:{settings}} as never)
 const {revision}=await initial()
 for(const disable of [()=>{settings.enabledAgents=[]},()=>{settings.enabledAgents=['codex'];settings.picker.agents.enabled=false}]){
  disable()
  for(const [name,args] of [['reference_read',{}],['reference_read',{part:'tools'}],['reference_search',{query:'color'}],['reference_image',{imageId:1}]] as const){
   const result=await call(name,{ref:locator,revision,...args});expect(result.isError).toBe(true);expect(text(result)).toContain('disabled')
  }
  const list=await call('reference_list',{source:'codex'});expect(list.isError).toBe(true)
  expect(preview((await step())[1])[0].error.code).toBe('SOURCE_DISABLED')
 }
 settings.picker.agents.enabled=true
 expect((await initial()).items.length).toBeGreaterThan(0)
})

it.each(['copilot-cli', 'copilot-vscode', 'doubao'])('reads %s through reference tools and enforces source switches',async source=>{
 const file = source === 'doubao' ? 'doubao.leveldb-log' : source + (source === 'copilot-cli' ? '.jsonl' : '.json')
 const path = source === 'doubao' ? join(root,'chrome_doubao-chat_0.indexeddb.leveldb') : join(root,file)
 if(source === 'doubao') await mkdir(path)
 await writeFile(source === 'doubao' ? join(path,'000001.log') : path,await readFile(resolve('tests/fixtures/chat-import-reader',file)))
 locator={source,path,sessionId:source==='doubao'?'conv-1':source==='copilot-cli'?'11111111-2222-3333-4444-555555555555':'copilot-example'}
 const settings={enabledAgents:[source],picker:{agents:{enabled:true}}}
 ctx.provide('referenceChatHistory',{getSettings:()=>settings,store:{settings}} as never)
 ctx.referenceLocalAgents.discoveryPolicy=()=>({roots:[{kind:source,path:root}],scope:'all'}) as never
 expect((await initial()).items.length).toBeGreaterThan(0)
 settings.enabledAgents=[]
 expect(text(await call('reference_read',{ref:locator}))).toContain('disabled')
})

it('does not invent tool ownership, separates calls/results and returns actual image blocks',async()=>{
 const doc=await loadLocalReference(ctx,agent,locator)
 const args={ref:locator,revision:doc.revision}
 const records=unwrap(await call('reference_read',{...args,part:'tools'})).items
 expect(records.map((r:any)=>r.toolId)).toEqual([1,2]);expect(records.map((r:any)=>r.kind)).toEqual(['call','result'])
 expect(records.every((r:any)=>r.messageId===undefined)).toBe(true)
 expect(records[0].callId).toBe(records[1].callId)
 expect(records[0].text).toBe('{"file":"test"}')
 expect(unwrap(await call('reference_read',{...args,part:'tools',from:{messageId:1}})).items).toEqual([])
 const images=unwrap(await call('reference_read',{...args,part:'images',from:{messageId:1}}))
 expect(images.items).toEqual([{imageId:1,messageId:1}])
 const saveImage=vi.fn(async()=>({attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',width:1,height:1,bytes:68}))
 ctx.provide('attachments',{saveImage})
 const result=await call('reference_image',{...args,imageId:1});unwrap(result)
 expect(result.content.some(b=>b.type==='image')).toBe(true)
 expect(saveImage).toHaveBeenCalledWith({data:Buffer.from(png,'base64'),mediaType:'image/png'})
})

it('invalidates all content operations after source changes',async()=>{
 const {revision}=await initial();await writeFile(locator.path,raw.replace('secret tool output','changed'))
 for(const [name,args] of [['reference_read',{}],['reference_search',{query:'red'}],['reference_image',{imageId:1}]] as const){
  const result=await call(name,{ref:locator,revision,...args});expect(result.isError).toBe(true);expect(text(result)).toContain('REVISION_CHANGED')
 }
 expect((await initial()).revision).not.toBe(revision)
})

it.each([{part:'tools'},{part:'images'},{from:{messageId:2}}])('requires a revision for $part $from',async args=>{
 const result=await call('reference_read',{ref:locator,...args});expect(result.isError).toBe(true);expect(text(result)).toContain('REVISION_REQUIRED')
})
it.each([{from:{messageId:0}},{from:{toolId:1}},{part:'images',from:{imageId:1,textOffset:0}},{from:{textOffset:1}},{maxItems:101},{messageId:1},{start:1},{from:{itemId:1}},{part:'body'}])('rejects wrong fields and old protocol: %j',async args=>{
 const {revision}=await initial();expect((await call('reference_read',{ref:locator,revision,...args})).isError).toBe(true)
})

it('preserves all Unicode text including escaping across bounded pages and never loops',async()=>{
 const content='中文🌏<references>\\"\n'.repeat(800)
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},message('user',content),message('assistant','END')].map(row=>JSON.stringify(row)).join('\n'))
 const doc=await loadLocalReference(ctx,agent,locator);let from:LocalFrom={messageId:1};let restored='',steps=0
 while(true){
  const page=await readLocalTool(ctx,agent,{ref:locator,revision:doc.revision,from,maxItems:1},900,new AbortController().signal)
  expect(localBytes(page)).toBeLessThanOrEqual(900)
  for(const row of page.items)if(row.messageId===1)restored+=row.text
  if(!page.next)break
  expect(page.next).not.toEqual(from);from=page.next;expect(++steps).toBeLessThan(500)
 }
 expect(restored).toBe(doc.messages[0]!.text)
})

it('keeps scope in tools/images next, splits tool text and rejects mismatched ownership',async()=>{
 const doc=await loadLocalReference(ctx,agent,locator)
 doc.tools=[{message:1,kind:'call',text:'short'},{message:2,kind:'result',text:'excluded'},{message:1,kind:'result',text:'中文🌏'.repeat(400)}]
 let from:LocalFrom={messageId:1},restored='';const seen=new Set<number>()
 do{
  const page=readLocalPage(doc,'tools',from,1,700)
  for(const item of page.items){seen.add(item.toolId!);if(item.toolId===3)restored+=item.text}
  if(!page.next)break
  expect(page.next.messageId).toBe(1);from=page.next
 }while(true)
 expect([...seen]).toEqual([1,3]);expect(restored).toBe(doc.tools[2]!.text)
 expect(()=>readLocalPage(doc,'tools',{messageId:1,toolId:2},20,5000)).toThrow('selected scope')
 doc.images.push({...doc.images[0]!,id:'image-2',message:2},{...doc.images[0]!,id:'image-3',message:1,name:'original.png'})
 expect(readLocalPage(doc,'images',{messageId:1},1,5000).next).toEqual({messageId:1,imageId:3})
 expect(readLocalPage(doc,'images',{},1,5000).next).toEqual({imageId:2})
 expect(readLocalPage(doc,'images',{messageId:1,imageId:3},1,5000).items[0]?.name).toBe('original.png')
})

it('handles empty scope, end offsets and too-small budgets without losing data',async()=>{
 const doc=await loadLocalReference(ctx,agent,locator)
 expect(readLocalPage(doc,'messages',{messageId:3},20,5000).items).toEqual([])
 expect(()=>readLocalPage(doc,'messages',{messageId:4},20,5000)).toThrow()
 expect(()=>readLocalPage(doc,'messages',{messageId:1,textOffset:99999},20,5000)).toThrow()
 expect(readLocalPage(doc,'messages',{messageId:1,textOffset:Array.from(doc.messages[0]!.text).length},20,5000).items[0]?.messageId).toBe(2)
 expect(()=>readLocalPage(doc,'messages',{},20,50)).toThrow('BUDGET_TOO_SMALL')
 doc.messages=[];doc.tools=[];doc.images=[]
 expect(readLocalPage(doc,'messages',{},20,5000)).toMatchObject({items:[],next:null})
})

it('searches case-sensitively, returns code-point hit positions and pages without gaps',async()=>{
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},...Array.from({length:8},(_,i)=>message('user','🌏中文 needle '+i+'中'.repeat(200)))].map(row=>JSON.stringify(row)).join('\n'))
 const {revision}=await initial();let from,seen:number[]=[]
 do{const page=unwrap(await call('reference_search',{ref:locator,revision,query:'needle',from,maxItems:2}));seen.push(...page.hits.map((h:any)=>h.position.messageId));expect(page.hits[0].position.textOffset).toBe(4);from=page.next}while(from)
 expect(seen).toEqual([1,2,3,4,5,6,7,8])
 expect(unwrap(await call('reference_search',{ref:locator,revision,query:'NEEDLE'})).hits).toEqual([])
 const match=unwrap(await call('reference_search',{ref:locator,revision,query:'needle',maxItems:1})).hits[0]
 expect(unwrap(await call('reference_read',{ref:locator,revision,from:match.position,maxItems:1})).items[0].text.startsWith('needle')).toBe(true)
 expect((await call('reference_search',{ref:locator,revision,query:'needle',from:{messageId:1,textOffset:0}})).isError).toBe(true)
 await writeFile(locator.path,raw);const fresh=await initial()
 expect(unwrap(await call('reference_search',{ref:locator,revision:fresh.revision,query:'secret tool output'})).hits).toEqual([])
 expect(unwrap(await call('reference_search',{ref:locator,revision:fresh.revision,part:'tools',query:'secret tool output'})).hits[0].position.toolId).toBe(2)
})

it('previews only a continuous tail, marks source summaries and never inserts old checkpoints',async()=>{
 const doc=await loadLocalReference(ctx,agent,locator)
 doc.messages=Array.from({length:8},(_,i)=>({number:i+1,role:'user' as const,text:'中文正文'.repeat(2000),checkpoint:i===0,images:[]}))
 const preview=buildLocalPreview(locator,doc,3000)
 expect(localBytes(preview)).toBeLessThanOrEqual(3000);expect(preview.items.map(i=>i.messageId)).toEqual([8]);expect(preview.next?.messageId).toBe(8)
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},message('user','Before'),{type:'compacted',payload:{message:'Checkpoint summary'}},message('assistant','After')].map(row=>JSON.stringify(row)).join('\n'))
 const page=await initial();expect(page.items.find((i:any)=>i.role==='summary')?.text).toContain('Checkpoint summary')
 expect(page.items.every((i:any)=>!Object.hasOwn(i,'checkpoint'))).toBe(true)
})

it('processes all direct messages after their owners, aggregates and does not recurse on replay',async()=>{
 const a=prompt(),b=prompt(locator,'Again');const messages=await step([a,b])
 expect(messages).toHaveLength(4);expect(messages[0]?.id).toBe(a.id);expect(messages[2]?.id).toBe(b.id)
 expect(preview(messages[1])[0].items[0].text).toContain('What color')
 expect(preview(messages[3])[0].ref).toEqual(locator)
 expect(text(messages[1]!)).not.toContain('secret tool output')
 const replay=await step([messages[1]!]);expect(replay).toHaveLength(1)
 const combined=createUserMessage({source:{kind:'user'},content:[{type:'text',text:text(a)+' '+text(a)}]})
 expect(preview((await step([combined]))[1])).toHaveLength(1)
})

it('shares one batch budget and keeps locators without loading bodies when capacity is unknown',async()=>{
 await mentionFiber.dispose();mentionFiber=await ctx.plugin(mention,{maxTextBytes:5000})
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},message('user','中文🌏'.repeat(4000))].map(row=>JSON.stringify(row)).join('\n'))
 const messages=await step([prompt(),prompt()])
 expect([messages[1],messages[3]].reduce((s,m)=>s+Buffer.byteLength(text(m!)),0)).toBeLessThanOrEqual(5000)
 expect(preview(messages[1])[0].items.length).toBeGreaterThan(0)
 ctx.llm.resolveModelInfo=async()=>({id:'test',provider:'test',name:'test'})
 const delayed=preview((await step())[1])[0]
 expect(delayed).toHaveProperty('notice');expect(delayed).not.toHaveProperty('revision');expect(delayed).not.toHaveProperty('items');expect(delayed).not.toHaveProperty('deferred')
})

it('retains path/identity guards and rejects symlink escapes',async()=>{
 const outside=await mkdtemp(join(tmpdir(),'outside-reference-'))
 try{
  const file=join(outside,'other.jsonl');await writeFile(file,raw)
  await expect(loadLocalReference(ctx,agent,{...locator,path:file})).rejects.toThrow('outside the allowed')
  const link=join(root,'escape');await symlink(outside,link,'junction')
  await expect(loadLocalReference(ctx,agent,{...locator,path:join(link,'other.jsonl')})).rejects.toThrow('outside the allowed')
  await expect(loadLocalReference(ctx,agent,{...locator,sessionId:'forged'})).rejects.toThrow()
 }finally{await rm(outside,{recursive:true,force:true})}
})

it('list cursors bind the complete sorted directory, query and source, not page size',async()=>{
 const service=ctx.get('referenceLocalAgents')!;const other={...locator,path:join(root,'other.jsonl'),sessionId:'other'}
 await writeFile(other.path,raw.replaceAll('sample','other'))
 let title='Other';service.referenceDirectory=async()=>({items:[{ref:{source:'local-agent',id:localLocatorId(locator)},label:'Color',updatedAt:1},{ref:{source:'local-agent',id:localLocatorId(other)},label:title,updatedAt:2}],warnings:[]})
 const first=unwrap(await call('reference_list',{maxItems:1}));expect(first.revision).toMatch(/^list:[a-f0-9]{64}$/);expect(first.items[0].title).toBe('Other')
 expect(unwrap(await call('reference_list',{revision:first.revision,from:first.next,maxItems:50})).items[0].ref).toEqual(locator)
 expect(unwrap(await call('reference_list',{query:'color'})).items).toEqual([])
 title='Changed';const stale=await call('reference_list',{revision:first.revision,from:first.next});expect(stale.isError).toBe(true);expect(text(stale)).toContain('REVISION_CHANGED')
})

it('preserves canonical values and respects host post-execute rejection',async()=>{
 const spill=vi.fn();ctx.on('tools/post-execute',async(_exec,_result,next)=>{const d=await next();if(d.kind==='accept'&&!Object.hasOwn(d,'value'))spill();return d},{prepend:true})
 await initial();expect(spill).not.toHaveBeenCalled()
 ctx.on('tools/post-execute',async()=>({kind:'block',feedback:[{type:'text',text:'Blocked by host policy'}]}))
 const result=await call('reference_read',{ref:locator});expect(result.isError).toBe(true);expect(text(result)).toContain('Blocked by host policy')
})

it('does not expand quoted code references and aborts preparation without publishing',async()=>{
 const code=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'```text\n'+text(prompt())+'\n```'}]})
 expect(await step([code])).toEqual([code])
 const controller=new AbortController();ctx.llm.resolveModelInfo=async()=>{controller.abort();throw Error('cancelled')}
 const messages=[prompt()]
 await expect(ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:controller.signal},async()=>({kind:'enter' as const,messages}))).rejects.toThrow()
})

it('reports partial list failures and budgets search results without dropping hits',async()=>{
 ctx.get('referenceLocalAgents')!.referenceDirectory=async()=>({items:[{ref:{source:'local-agent',id:localLocatorId(locator)},label:'Color'}],warnings:['claude: unavailable']})
 expect(unwrap(await call('reference_list',{})).notice).toContain('claude')
 expect((await call('reference_list',{source:'codex'})).isError).toBe(true)
 await toolFiber.dispose();toolFiber=await ctx.plugin(tool,{maxTextBytes:1400})
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},...Array.from({length:6},()=>message('user','中'.repeat(100)+'needle'+'文'.repeat(100)))].map(row=>JSON.stringify(row)).join('\n'))
 const {revision}=await initial();let from,ids:number[]=[]
 do{const page=unwrap(await call('reference_search',{ref:locator,revision,query:'needle',from,maxItems:50}));expect(localBytes(page)).toBeLessThanOrEqual(1400);ids.push(...page.hits.map((h:any)=>h.position.messageId));from=page.next}while(from)
 expect(ids).toEqual([1,2,3,4,5,6])
})

// Policy changes invalidate cursors even if the matching directory is unchanged.
it('invalidates list revisions when enabled source policy changes',async()=>{
 const settings={enabledAgents:['codex'],picker:{agents:{enabled:true}}}
 ctx.provide('referenceChatHistory',{getSettings:()=>settings,store:{settings}} as never)
 const page=unwrap(await call('reference_list',{}))
 settings.enabledAgents.push('claude-code')
 const result=await call('reference_list',{revision:page.revision,from:{index:1}})
 expect(result.isError).toBe(true);expect(text(result)).toContain('REVISION_CHANGED')
})
