import { readLocalConversation } from '../src/local-conversation-reader.ts'
vi.mock('../src/local-conversation-reader.ts', async importOriginal => ({ ...await importOriginal<object>(), readLocalConversation: vi.fn() }))
beforeEach(() => { vi.mocked(readLocalConversation).mockResolvedValue(page) })
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { chatImportReference, chatImportTarget, readChatImport } from '../src/chat-import-reader.ts'
import { ALL_LOCAL_AGENTS } from '../src/wire.ts'
import { scanFormat } from '../src/chat-import-discovery.ts'

const image = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 8, width: 1, height: 1 } as const
const target = { format: 'antigravity', path: '/history/session.jsonl', sessionId: 's' }
const ref = { source: 'local-agent', id: chatImportReference(target) }
const page = { title: 'Read me', revision: 'v1', startIndex: 1, totalMessages: 2, hasOlder: true, partial: false,
 items: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }] }] }

describe('Chat Import reference reader', () => {
 it.each(ALL_LOCAL_AGENTS)('keeps a durable exact source locator for %s', kind => {
   const value = { ...target, format: scanFormat(kind) }
   expect(chatImportTarget(chatImportReference(value))).toEqual(value)
 })
 it('reads a page, stores its image, and pins the next page to the same reference', async () => {
   const ctx=new Context()
   const readConversation=vi.fn(async()=>page)
   const saveImage=vi.fn(async()=>image)
   ctx.provide('chatImport',{readConversation})
   ctx.provide('attachments',{saveImage})
   const out=await readChatImport(ctx,ref,target,{limit:1})
   expect(out.body.items[0]?.images).toEqual([image])
   expect(saveImage).toHaveBeenCalledOnce()
   await readChatImport(ctx,ref,target,{limit:1,cursor:out.body.nextCursor})
   expect(readConversation).not.toHaveBeenCalled()
   expect(readLocalConversation).toHaveBeenLastCalledWith(expect.objectContaining({before:1,revision:'v1'}),undefined)
   await expect(readChatImport(ctx,{...ref,id:ref.id+'x'},target,{limit:1,cursor:out.body.nextCursor})).rejects.toThrow()
 })
 it('reports image loss without losing text, without a usable attachment service', async () => {
   const ctx=new Context()
   ctx.provide('chatImport',{readConversation:async()=>page})
   const out=await readChatImport(ctx,ref,target,{limit:1})
   expect(out.partial).toBe(true)
   expect(out.body.items[0]?.text).toContain('What is this?')
   expect(out.body.items[0]?.text).toContain('image unavailable')
   expect(out.body.items[0]?.images).toBeUndefined()
   expect((await readChatImport(new Context(),ref,target,{limit:1})).body.items).toHaveLength(1)
 })
 it('validates existing attachment availability before returning it', async () => {
   const ctx=new Context()
   ctx.provide('chatImport',{readConversation:async()=>({...page,items:[{role:'user',content:[{type:'image',attachment:image}]}]})})
   vi.mocked(readLocalConversation).mockResolvedValueOnce({...page,items:[{role:'user',content:[{type:'image',attachment:image}]}]})
   const readImage=vi.fn(async()=>{throw new Error('missing')})
   ctx.provide('attachments',{readImage})
   const out=await readChatImport(ctx,ref,target,{limit:1})
   expect(readImage).toHaveBeenCalledOnce()
   expect(out.partial).toBe(true)
   expect(out.body.items[0]?.images).toBeUndefined()
 })
})

import { LocalAgentService } from '../src/sources/local-agent/index.ts'
import { ReferenceAnythingRemote } from '../src/host.ts'

it('offers all sources with only the npm 0.26.1 scan API and quick import disabled', async () => {
 const ctx = new Context()
 const settings = { enabledAgents: [...ALL_LOCAL_AGENTS], picker: { agents: { showImport: false } } }
 ctx.provide('referenceChatHistory', { store: { settings }, getSettings: () => settings })
 const service = new LocalAgentService(ctx, { scope: 'all' })
 ctx.provide('chatImport', { scanDiscover: async ({ format }: { format: string }) => ({ sessions: [{ format, sessionId: 's', sourcePath: '/history/' + format, importStatus: 'not-imported' }], warnings: [] }) })
 vi.spyOn(service.scanner, 'scanDiscover').mockImplementation(ctx.get('chatImport')!.scanDiscover as never)
 vi.spyOn(service.conversationAvailability, 'visible').mockResolvedValue(true)
 const rows = await new ReferenceAnythingRemote(ctx).agentSearch({ session: { header: { id: 'owner' } } } as never, { query: '', limit: 50 }, new AbortController().signal)
 expect(rows).toHaveLength(ALL_LOCAL_AGENTS.length)
 expect(rows.every(row => 'referenceId' in row && row.referenceId && !row.importOnly)).toBe(true)
})

it('offers all scanned formats as readable references even when quick import is off', async () => {
 const ctx=new Context()
 ctx.provide('referenceChatHistory',{store:{settings:{enabledAgents:['antigravity']}},getSettings:()=>({enabledAgents:['antigravity'],picker:{agents:{showImport:false}},agentDirectories:{}})})
 const service=new LocalAgentService(ctx,{scope:'all'})
 const readConversation=vi.fn(async()=>page)
 const scanDiscover=vi.fn(async()=>({sessions:[{format:'antigravity',sessionId:'s',sourcePath:target.path,title:'Image history',importStatus:'not-imported'}],warnings:[]}))
 ctx.provide('chatImport',{readConversation,scanDiscover,discoveryRoots:()=>({antigravity:['/history']})})
 vi.spyOn(service.scanner,'scanDiscover').mockImplementation(scanDiscover as never)
 vi.spyOn(service.conversationAvailability,'visible').mockResolvedValue(true)
 const remote=new ReferenceAnythingRemote(ctx)
 const signal=new AbortController().signal
 const rows=await remote.agentSearch({session:{header:{id:'owner',cwd:'/work'}}} as never,{query:'',limit:5},signal)
 expect(rows).toHaveLength(1)
 expect(rows[0]).not.toHaveProperty('importOnly',true)
 const row=rows[0]!
 if (!('referenceId' in row) || !row.referenceId) throw new Error('Missing readable reference')
 expect(chatImportTarget(row.referenceId)).toEqual(target)
 const out=await service.read({source:'local-agent',id:row.referenceId},{limit:1},signal)
 expect(out.body.items[0]?.text).toContain('What is this?')
 expect(readConversation).not.toHaveBeenCalled()
})


it.each([
 ['not-json', 'malformed'],
 [Buffer.from(JSON.stringify({id:'wrong',before:1,revision:'v1'})).toString('base64url'), 'does not match'],
])('explains invalid cursors without exposing their contents', async (cursor, reason) => {
 vi.mocked(readLocalConversation).mockClear()
 await expect(readChatImport(new Context(),ref,target,{limit:1,cursor})).rejects.toMatchObject({code:'REFERENCE_INVALID_CURSOR',message:expect.stringContaining(reason)})
 expect(readLocalConversation).not.toHaveBeenCalled()
})

it.each([
 ['Conversation changed; read its latest page again', 'REFERENCE_CURSOR_EXPIRED', 'omit cursor'],
 ['Conversation source not found: /private/path', 'REFERENCE_NOT_FOUND', 'no longer exists'],
 ['Conversation body unavailable: this Claude Desktop file contains metadata only.', 'REFERENCE_NOT_FOUND', 'metadata only'],
 ['Conversation could not be read: secret transcript content', 'REFERENCE_READ_FAILED', 'parser could not read'],
])('explains local reader failures: %s', async (message, code, explanation) => {
 vi.mocked(readLocalConversation).mockRejectedValueOnce(new Error(message))
 const error=await readChatImport(new Context(),ref,target,{limit:1}).catch(error=>error)
 expect(error).toMatchObject({code,message:expect.stringContaining(explanation)})
 expect(error.message).not.toContain('secret transcript content')
 expect(error.message).not.toContain('/private/path')
})


it.each(['EACCES','EPERM'])('reports %s without exposing file paths', async code => {
 vi.mocked(readLocalConversation).mockRejectedValueOnce(Object.assign(new Error('/private/path'),{code}))
 await expect(readChatImport(new Context(),ref,target,{limit:1})).rejects.toMatchObject({code:'REFERENCE_READ_FAILED',message:expect.stringContaining('Permission denied')})
})

it('preserves cancellation instead of reporting a parser failure', async () => {
 const controller=new AbortController()
 const reason=new Error('cancelled')
 vi.mocked(readLocalConversation).mockImplementationOnce(async()=>{controller.abort(reason);throw reason})
 await expect(readChatImport(new Context(),ref,target,{limit:1},controller.signal)).rejects.toBe(reason)
})
