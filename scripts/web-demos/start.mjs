import {mkdirSync,existsSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawn} from 'node:child_process'
import assert from 'node:assert/strict'

const root=resolve(import.meta.dirname,'../..')
const demo=join(root,'.codex-tmp/web-demos')
const user=join(demo,'user')
const workspace=join(demo,'workspace')
const cli=join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
assert(existsSync(cli),'Install the DSH CLI before launching the demo')
for(const dir of [user,workspace,join(user,'AppData/Roaming'),join(user,'AppData/Local'),join(workspace,'docs/testing')])mkdirSync(dir,{recursive:true})
const sample=join(workspace,'docs/testing/demo.md')
if(!existsSync(sample))writeFileSync(sample,'# 演示工作区\n\n这里的文件和会话仅用于产品演示。\n')
const env={...process.env,DSH_HOME:join(demo,'dsh-home'),HOME:user,USERPROFILE:user,APPDATA:join(user,'AppData/Roaming'),LOCALAPPDATA:join(user,'AppData/Local'),CODEX_HOME:join(user,'.codex'),CLAUDE_CONFIG_DIR:join(user,'.claude')}
// Do not inherit credentials into a disposable product demonstration.
for(const key of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)$/i.test(key))delete env[key]
assert.notEqual(env.DSH_HOME,process.env.DSH_HOME)
assert.notEqual(env.USERPROFILE,process.env.USERPROFILE)
const child=spawn(process.execPath,[cli,'web','--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env,stdio:['inherit','pipe','inherit'],windowsHide:true})
let startup=''
child.stdout.on('data',chunk=>{
 process.stdout.write(chunk)
 startup=(startup+chunk.toString()).slice(-4096)
 const match=startup.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/)
 if(match)writeFileSync(join(demo,'instance.json'),JSON.stringify({url:match[1],pid:child.pid}))
})
child.on('error',error=>{console.error(error);process.exitCode=1})
child.on('exit',code=>{process.exitCode=code??1})
process.on('SIGINT',()=>child.kill('SIGINT'))
process.on('SIGTERM',()=>child.kill('SIGTERM'))
