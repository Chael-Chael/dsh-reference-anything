import {cpSync,mkdirSync,existsSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs'
import {resolve,join,sep} from 'node:path'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'../..'),demo=join(root,'.codex-tmp/web-demos')
const archive=join(root,'demo-recordings/html-original-'+Date.now())
mkdirSync(archive,{recursive:true})
for(const [source,target] of [['scripts/feature-demos','source'],['release-notes/0.4.4/demos','gifs'],['.codex-tmp/feature-demos','preview']])cpSync(join(root,source),join(archive,target),{recursive:true,filter:path=>!path.includes('node_modules')&&!path.includes('-motion')&&!path.includes('previous-')})
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
for(const id of ['folders','agent-import','chat-import-upgrade','local-plugins','shortcuts'])assert.equal(hash(join(root,'release-notes/0.4.4/demos',id+'.gif')),hash(join(archive,'gifs',id+'.gif')))
const plugin=join(demo,'plugin')
mkdirSync(plugin,{recursive:true})
for(const name of ['lib','package.json','cordis.patch.yml','images','locale','vendor','release-notes'])if(existsSync(join(root,name)))cpSync(join(root,name),join(plugin,name),{recursive:true})
if(!existsSync(join(plugin,'node_modules')))symlinkSync(join(root,'node_modules'),join(plugin,'node_modules'),'junction')
cpSync(join(root,'scripts/web-demos/fixtures.mjs'),join(plugin,'lib/demo-fixtures.js'))
const web=join(plugin,'lib/web.js');writeFileSync(web,"import './demo-fixtures.js';\n"+readFileSync(web,'utf8'))
writeFileSync(join(demo,'mode.json'),JSON.stringify({scene:'folders'}))
const profile=join(demo,'dsh-home/profiles/web'),manifest=JSON.parse(readFileSync(join(profile,'package.json'),'utf8'))
manifest.dependencies['dsh-reference-anything']='file:'+plugin.replaceAll('\\','/')
if(!manifest.dsh.profile.bundles.includes('dsh-reference-anything'))manifest.dsh.profile.bundles.push('dsh-reference-anything')
mkdirSync(join(profile,'node_modules'),{recursive:true})
if(!existsSync(join(profile,'node_modules/dsh-reference-anything')))symlinkSync(plugin,join(profile,'node_modules/dsh-reference-anything'),'junction')
writeFileSync(join(profile,'package.json'),JSON.stringify(manifest,null,2))
const patch=join(profile,'cordis.patch.yml'),old=readFileSync(patch,'utf8')
if(!old.includes('# Demo isolation'))writeFileSync(patch,old+'\n# Demo isolation: fixture Remote handles these, never scan or install.\n- id: reference-chat-import-runtime\n  disabled: true\n- id: reference-local-agent\n  disabled: true\n')
for(const [path,text] of [['README.md','# 演示项目'],['docs/api.md','# API 设计'],['docs/guide.md','# 使用指南'],['docs/testing/verification.md','# 验证清单'],['docs/testing/start.ps1','# 演示启动脚本']]){const file=join(demo,'workspace',path);mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,text+'\n')}
const workspaceStore=join(demo,'dsh-home/storages/workspace.json')
if(existsSync(workspaceStore)){
 const state=JSON.parse(readFileSync(workspaceStore,'utf8'))
 const target=state.tables.workspaces[state.global.defaultWorkspaceId].path
 assert(resolve(target).startsWith(demo+sep))
 cpSync(join(demo,'workspace'),target,{recursive:true})
}
console.log(JSON.stringify({archive,plugin,profile}))
