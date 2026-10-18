import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { loadLocalReference, renderLocalPreview } from '../src/local-reference.ts'

let mentionFiber: { dispose(): Promise<void> }
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
 ctx.provide('referenceLocalAgents',{discoveryPolicy:()=>({roots:[{kind:'codex',path:root}],scope:'all'})})
 await ctx.plugin(SystemPrompt,{})
 await ctx.plugin(ToolRuntime,{})
 await ctx.plugin(tool,{})
 mentionFiber=await ctx.plugin(mention,{})
 ctx.provide('llm',{resolveModelInfo:async()=>({context:{contextWindow:100000}})})
 agent={session:Session.create(SessionId('local-test')),options:{provider:'test',model:'test'}} as Agent
})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
const text=(result:{content:readonly {type:string;text?:string}[]})=>result.content.filter(row=>row.type==='text').map(row=>row.text).join('\n')
const grant=()=>ctx.references.grant(String(agent.session.id),{source:'local-agent',id:localLocatorId(locator)})
const call=(name:string,args:unknown)=>ctx.tools.execute({agent,signal:new AbortController().signal,callId:'t' as never,name,arguments:args})

it('injects actual body, durable locator and image directory before the first model response',async()=>{
 const prompt=createUserMessage({source:{kind:'user'},content:[{type:'text',text:formatReferenceMention({source:'local-agent',id:localLocatorId(locator)},'Color')}]})
 const result=await ctx.waterfall('agent/pre-step',{agent,messages:[prompt],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[prompt]}))
 if(result.kind!=='enter') throw Error('rejected')
 const preview=text(result.messages[0]!)
 expect(preview).toContain('What color is this?')
 expect(preview).toContain('image-1')
 expect(preview).toContain('"totalMessages": 2')
 expect(preview).not.toContain('secret tool output')
 expect(preview).not.toMatch(/dsh-ref:|ref:[a-f0-9]|nextCursor|fullSnapshot|tool details omitted/)
 const fields=parseReferenceText(preview).references
 expect(fields[0]?.ref.id).toBe(localLocatorId(locator))
 // Resumed session after in-memory grants have been discarded.
 agent.session.append('user/message',result.messages[0]!,{surfaceOp:'append'})
 ctx.references.revoke(String(agent.session.id))
 expect((await loadLocalReference(ctx,agent,locator)).messages).toHaveLength(2)
 // A different session must copy the complete block; the title alone grants nothing.
 const other={session:Session.create(SessionId('copy-test'))} as Agent
 await expect(loadLocalReference(ctx,other,locator)).rejects.toThrow('not been granted')
 other.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:preview}]}),{surfaceOp:'append'})
 expect((await loadLocalReference(ctx,other,locator)).messages).toHaveLength(2)
})

it('uses stable body numbers, linked tool details, search and actual image blocks',async()=>{
 grant()
 const document=await loadLocalReference(ctx,agent,locator)
 expect(document.messages.map(row=>row.number)).toEqual([1,2])
 expect(document.tools.map(row=>row.message)).toEqual([1,1])
 const args={...locator,revision:document.revision}
 const body=await call('reference_read',{...args,start:1,limit:1})
 expect(body.isError,text(body)).not.toBe(true)
 expect(text(body)).toContain('What color is this?')
 expect(text(body)).not.toContain('It is red.')
 expect(text(await call('reference_read',{...args,start:1,limit:1,mode:'tools'}))).toContain('secret tool output')
 expect(text(await call('reference_search',{...args,query:'red'}))).toContain('"number": 2')
 const saveImage=vi.fn(async()=>({attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/png',width:1,height:1,bytes:68}))
 ctx.provide('attachments',{saveImage})
 const image=await call('reference_image',{...args,imageId:'image-1'})
 expect(image.isError).not.toBe(true)
 expect(image.content.some(block=>block.type==='image')).toBe(true)
 expect(saveImage).toHaveBeenCalledWith({data:Buffer.from(png,'base64'),mediaType:'image/png'})
 await writeFile(locator.path,raw.replace('secret tool output','changed tool output'))
 for(const [name,extra] of [['reference_read',{start:1}],['reference_search',{query:'red'}],['reference_image',{imageId:'image-1'}]] as const){
  const result=await call(name,{...args,...extra});expect(result.isError).toBe(true);expect(text(result)).toContain('source changed')
 }
 expect(text(await call('reference_read',locator))).toContain('What color is this?')
})

it('rejects arbitrary paths even with a forged/copied grant and checks session identity',async()=>{
 grant()
 const outside=await mkdtemp(join(tmpdir(),'outside-reference-'))
 try{
  const path=join(outside,'other.jsonl');await writeFile(path,raw)
  const target={...locator,path};ctx.references.grant(String(agent.session.id),{source:'local-agent',id:localLocatorId(target)})
  await expect(loadLocalReference(ctx,agent,target)).rejects.toThrow('outside the allowed roots')
  const link=join(root,'linked');await symlink(outside,link,'junction')
  const linked={...locator,path:join(link,'other.jsonl')};ctx.references.grant(String(agent.session.id),{source:'local-agent',id:localLocatorId(linked)})
  await expect(loadLocalReference(ctx,agent,linked)).rejects.toThrow('outside the allowed roots')
 }finally{await rm(outside,{recursive:true,force:true})}
 await writeFile(locator.path,raw.replace('"id":"sample"','"id":"other"'))
 await expect(loadLocalReference(ctx,agent,locator)).rejects.toThrow('different sessionId')
})

it('fits the complete UTF-8 preview, distinguishes omissions and retains checkpoints and the newest message',async()=>{
 grant();const doc=await loadLocalReference(ctx,agent,locator)
 doc.messages=Array.from({length:8},(_,i)=>({number:i+1,role:'user' as const,text:'中文正文'.repeat(2000),checkpoint:i===0,images:[]}))
 const preview=renderLocalPreview(locator,doc,5000)
 expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(5000)
 const data=JSON.parse(preview.split('<local-agent-reference>')[1]!.split('</local-agent-reference>')[0]!)
 expect(data.messages.map((row:{number:number})=>row.number)).toEqual([1,8])
 expect(data.omissions.omittedMessageRanges).toEqual([[2,7]])
 expect(data.omissions.truncatedMessages.length).toBeGreaterThan(0)
 expect(data.omissions.toolRecordsNotExpanded).toBe(2)
 expect(data.omissions.imageContentsNotRead).toBe(1)
})


it('restores a locator discovered by reference_list and does not treat quoted URIs as extra grants', async()=>{
 const listed=await call('reference_list',{})
 expect(listed.isError,text(listed)).not.toBe(true)
 expect(parseReferenceText(text(listed)).references[0]?.ref.id).toBe(localLocatorId(locator))
 agent.session.append('tool/result',{message:{content:listed.content}} as never,{surfaceOp:'append'})
 ctx.references.revoke(String(agent.session.id))
 expect((await loadLocalReference(ctx,agent,locator)).messages).toHaveLength(2)
 const doc=await loadLocalReference(ctx,agent,locator)
 doc.messages[0]!.text='Quoted invalid reference: @[old](dsh-ref:bad)'
 const parsed=parseReferenceText(renderLocalPreview(locator,doc,65536))
 expect(parsed.references).toHaveLength(1)
})

it.each([
 {tokens:100000, explicit:undefined, expected:80000},
 {tokens:100000, explicit:5000, expected:5000},
])('caps shared serialized previews at $expected',async({tokens,explicit,expected})=>{
 await mentionFiber.dispose()
 mentionFiber=await ctx.plugin(mention,{maxReferenceBytes:explicit})
 ctx.llm.resolveModelInfo=async()=>({id:'test',provider:'test',name:'test',context:tokens?{contextWindow:tokens}:undefined})
 agent={session:agent.session,options:{provider:'test',model:'test'}} as Agent
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},message('user','中文'.repeat(50000))].map(row=>JSON.stringify(row)).join('\n'))
 const prompt=createUserMessage({source:{kind:'user'},content:[{type:'text',text:formatReferenceMention({source:'local-agent',id:localLocatorId(locator)},'Budget')}]})
 const result=await ctx.waterfall('agent/pre-step',{agent,messages:[prompt],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[prompt]}))
 if(result.kind!=='enter') throw Error('rejected')
 const bytes=Buffer.byteLength(text(result.messages[0]!))
 expect(bytes).toBeLessThanOrEqual(expected)
 expect(bytes).toBeGreaterThan(expected-1000)
})

it('shares remaining space, recounts later sends, and preserves the user question',async()=>{
 const other={...locator,path:join(root,'second.jsonl'),sessionId:'second'}
 for(const item of [locator,other]) await writeFile(item.path,[{type:'session_meta',payload:{id:item.sessionId}},message('user','正文🌏'.repeat(30000))].map(row=>JSON.stringify(row)).join('\n'))
 let used=60000
 const measure=vi.fn(()=>({totalTokens:used,baseline:{kind:'usage'}}))
 ctx.provide('tokenMeter',{measure})
 ctx.llm.resolveModelInfo=async()=>({id:'test',provider:'test',name:'test',context:{contextWindow:100000},defaultMaxTokens:8000})
 agent={session:agent.session,options:{provider:'test',model:'test'}} as Agent
 const prompt=createUserMessage({source:{kind:'user'},content:[{type:'text',text:[locator,other].map(l=>formatReferenceMention({source:'local-agent',id:localLocatorId(l)},'Budget')).join(' ')+' Compare without changing files.'}]})
 const send=async()=>{
  const result=await ctx.waterfall('agent/pre-step',{agent,messages:[prompt],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[prompt]}))
  if(result.kind!=='enter') throw Error('rejected')
  expect(text(result.messages.at(-1)!)).toContain('Compare without changing files.')
  return result.messages.slice(0,-1).map(m=>text(m))
 }
 const first=await send()
 expect(first).toHaveLength(2)
 expect(first.every(t=>t.includes('正文'))).toBe(true)
 expect(first.reduce((sum,t)=>sum+Buffer.byteLength(t),0)).toBeLessThan(27000)
 used=78000
 const later=await send()
 expect(later.reduce((sum,t)=>sum+Buffer.byteLength(t),0)).toBeLessThan(9000)
 expect(measure).toHaveBeenCalledTimes(2)
 used=99000
 const full=await send()
 expect(full.every(t=>t.includes('source')&&t.includes('sessionId')&&!t.includes('正文'))).toBe(true)
})

it('does not parse bodies when capacity is unknown or a large configured cap exceeds remaining space',async()=>{
 await mentionFiber.dispose()
 mentionFiber=await ctx.plugin(mention,{maxReferenceBytes:9999999})
 ctx.llm.resolveModelInfo=async()=>({id:'test',provider:'test',name:'test'})
 agent={session:agent.session,options:{provider:'test',model:'test'}} as Agent
 await rm(locator.path)
 const prompt=createUserMessage({source:{kind:'user'},content:[{type:'text',text:formatReferenceMention({source:'local-agent',id:localLocatorId(locator)},'Unavailable budget')}]})
 const result=await ctx.waterfall('agent/pre-step',{agent,messages:[prompt],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[prompt]}))
 if(result.kind!=='enter') throw Error('rejected')
 expect(text(result.messages[0]!)).toContain('preview deferred')
 expect(text(result.messages[0]!)).not.toContain('no longer exists')
})

it.each(['history','pending','system','tools','output'] as const)('accounts for %s before expanding local bodies',async(kind)=>{
 ctx.llm.resolveModelInfo=async()=>({id:'test',provider:'test',name:'test',context:{contextWindow:20000},defaultMaxTokens:2000})
 const large='保留当前指令🌏'.repeat(3000)
 if(kind==='history') agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:large}]}),{surfaceOp:'append'})
 if(kind==='output') agent={...agent,options:{...agent.options,maxTokens:20000}} as Agent
 const assembly={sections:kind==='system'?[{name:'instruction',text:large}]:[],contexts:[],tools:kind==='tools'?[{name:'large',description:large,parameters:{type:'object' as const,properties:{}}}]:[],variables:{provider:'test',model:'test'}}
 await ctx.waterfall('system-prompt/assemble',assembly,{agent},async()=>assembly)
 const question=kind==='pending'?large:'Keep this exact question.'
 const prompt=createUserMessage({source:{kind:'user'},content:[{type:'text',text:formatReferenceMention({source:'local-agent',id:localLocatorId(locator)},'Color')+' '+question}]})
 const result=await ctx.waterfall('agent/pre-step',{agent,messages:[prompt],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[prompt]}))
 if(result.kind!=='enter') throw Error('rejected')
 expect(text(result.messages[0]!)).toContain('preview deferred')
 expect(text(result.messages.at(-1)!)).toContain(question)
 expect(assembly.sections[0]?.text).toBe(kind==='system'?large:undefined)
})

it('does not reuse usage from a different model and recovers space after history compaction',async()=>{
 agent.session.append('request/header',{header:{config:{provider:'old',model:'old'}}} as never)
 const measure=vi.fn(()=>({totalTokens:9999999,baseline:{kind:'usage'}}))
 ctx.provide('tokenMeter',{measure})
 const prompt=createUserMessage({source:{kind:'user'},content:[{type:'text',text:formatReferenceMention({source:'local-agent',id:localLocatorId(locator)},'Color')}]})
 const send=()=>ctx.waterfall('agent/pre-step',{agent,messages:[prompt],turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages:[prompt]}))
 const result=await send()
 if(result.kind!=='enter') throw Error('rejected')
 expect(text(result.messages[0]!)).toContain('What color is this?')
 agent.session.append('request/header',{header:{config:{provider:'test',model:'test'}}} as never)
 const full=await send()
 if(full.kind!=='enter') throw Error('rejected')
 expect(text(full.messages[0]!)).toContain('preview deferred')
 measure.mockReturnValue({totalTokens:1000,baseline:{kind:'usage'}})
 const compacted=await send()
 if(compacted.kind!=='enter') throw Error('rejected')
 expect(text(compacted.messages[0]!)).toContain('What color is this?')
})


it('keeps real Codex attachment prompts and compaction checkpoints alongside full history', async()=>{
 grant()
 await writeFile(locator.path,[{type:'session_meta',payload:{id:'sample'}},
  message('user',"# Files mentioned by the user:\n## image.png\nImage attachment: true\n## My request:\nFix the logo",true),
  message('assistant','Fixed the logo'),
  {type:'compacted',payload:{message:'Checkpoint: logo fixed'}},
  message('user','Please verify'),message('assistant','Verified')].map(row=>JSON.stringify(row)).join('\n'))
 const doc=await loadLocalReference(ctx,agent,locator)
 expect(doc.messages[0]!.text).toBe('Fix the logo')
 expect(doc.images).toHaveLength(1)
 expect(doc.messages.find(row=>row.checkpoint)?.text).toContain('Checkpoint: logo fixed')
 expect(doc.messages.at(-1)!.text).toBe('Verified')
})


it('keeps bounded local output canonical while respecting post-execute denials',async()=>{
 grant()
 const spill=vi.fn()
 ctx.on('tools/post-execute',async(_exec,_result,next)=>{
  const decision=await next()
  if(decision.kind==='accept' && !Object.hasOwn(decision,'value')) spill()
  return decision
 },{prepend:true})
 const result=await call('reference_read',{...locator,start:1,limit:1})
 expect(result.isError).not.toBe(true)
 expect(spill).not.toHaveBeenCalled()
 ctx.on('tools/post-execute',async()=>({kind:'block',feedback:[{type:'text',text:'Blocked by host policy'}]}))
 const blocked=await call('reference_read',locator)
 expect(blocked.isError).toBe(true)
 expect(text(blocked)).toContain('Blocked by host policy')
})
