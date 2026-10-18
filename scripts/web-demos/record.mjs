import {createRequire} from 'node:module'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright')
const root=resolve(import.meta.dirname,'../..'),demo=join(root,'.codex-tmp/web-demos')
const url=process.env.DSH_DEMO_URL||JSON.parse(readFileSync(join(demo,'instance.json'),'utf8')).url
assert(url&&new URL(url).hostname==='127.0.0.1','DSH_DEMO_URL must target the isolated local instance')
const output=join(root,'demo-recordings','web-'+Date.now())
mkdirSync(output,{recursive:true})
const font=readFileSync(join(root,'scripts/feature-demos/vendor/SourceHanSansSC-VF.otf')).toString('base64')
const browser=await chromium.launch({channel:'msedge',headless:true})
const names={'folders':'目录浏览与引用','agent-import':'会话引用与导入','chat-import-upgrade':'升级 Chat Import','local-plugins':'本地插件引用','shortcuts':'自定义与共享快捷词','local-references':'跨来源会话只读引用'}
const ids=process.argv.slice(2).length?process.argv.slice(2):Object.keys(names)
const results=[]
let activePage
try{for(const id of ids){
 assert(id in names)
 writeFileSync(join(demo,'mode.json'),JSON.stringify({scene:id}))
 const context=await browser.newContext({viewport:{width:1280,height:800},locale:'zh-CN',colorScheme:'light',recordVideo:{dir:join(output,'raw'),size:{width:1280,height:800}}})
 const page=await context.newPage(),epoch=Date.now(),errors=[]
 activePage=page
 page.on('pageerror',e=>errors.push(e.message))
 page.setDefaultTimeout(20000)
 await page.goto(url)
 const onboarding=page.getByRole('dialog',{name:'开始使用',exact:true})
 await onboarding.waitFor({state:'visible',timeout:5000}).catch(()=>{})
 if(await onboarding.isVisible())await onboarding.getByRole('button',{name:'关闭',exact:true}).click()
 const editor=page.locator('[contenteditable="true"]').first()
 await editor.waitFor()
 await page.addStyleTag({content:`@font-face{font-family:DemoSourceHan;src:url(data:font/otf;base64,${font})}body,button,input,textarea,[contenteditable],body *{font-family:DemoSourceHan,sans-serif!important}#demo-key{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#fff;box-shadow:0 3px 14px #0002;border:1px solid #d6d9e0;border-bottom-width:3px;border-radius:9px;padding:12px 26px;z-index:2147483647;font-size:24px;display:flex;align-items:center;gap:18px;white-space:nowrap;opacity:0;transition:opacity .15s;pointer-events:none}#demo-key kbd{font-size:32px;font-weight:700;line-height:1.2;padding:5px 12px;border:1px solid #cdd2df;border-bottom:3px solid #b5bdce;border-radius:7px;background:#f2f4fa;color:#284cda}#demo-pointer{position:fixed;left:0;top:0;width:25px;height:32px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 2px #0003)}.demo-ring{position:fixed;width:38px;height:38px;margin:-19px;border:2px solid #4d6bfe;border-radius:50%;pointer-events:none;z-index:2147483646;animation:demo-pulse .55s ease-out forwards}@keyframes demo-pulse{from{transform:scale(.4);opacity:1}to{transform:scale(1.5);opacity:0}}`})
 await page.evaluate(scene=>{const key=document.createElement('div');key.id='demo-key';document.body.append(key);const cursor=document.createElement('div');cursor.id='demo-pointer';cursor.innerHTML='<svg viewBox="0 0 28 36"><path d="M3 2 L3 27 L9 21 L15 33 L20 30 L14 19 L24 18 Z" fill="#171b26" stroke="white" stroke-width="2.2" stroke-linejoin="round"/></svg>';document.body.append(cursor);window.addEventListener('mousemove',e=>{cursor.style.left=e.clientX+'px';cursor.style.top=e.clientY+'px'});window.addEventListener('mousedown',e=>{const ring=document.createElement('div');ring.className='demo-ring';ring.style.left=e.clientX+'px';ring.style.top=e.clientY+'px';document.body.append(ring);setTimeout(()=>ring.remove(),600)});window.addEventListener('keydown',e=>{if(!['Tab','Enter','Escape','Backspace'].includes(e.key))return;const descriptions={folders:{Tab:'进入目录，继续浏览',Enter:'插入目录引用'},'agent-import':{Tab:'打开导入选项',Enter:'插入会话引用'},'local-plugins':{Enter:'插入插件引用'},shortcuts:{Tab:'完成输入，移至下一项'}};const description=descriptions[scene]?.[e.key]||{Escape:'收起菜单',Backspace:'清除当前引用'}[e.key];if(!description)return;const cap=document.createElement('kbd');cap.textContent=e.key;const label=document.createElement('span');label.textContent=description;key.replaceChildren(cap,label);key.style.opacity='1';clearTimeout(window.demoKeyTimer);window.demoKeyTimer=setTimeout(()=>key.style.opacity='0',2000)},true)},id)
 await page.evaluate(()=>document.fonts.ready)
 const pause=ms=>page.waitForTimeout(ms)
 async function click(locator){await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox();assert(b);await page.mouse.move(b.x+b.width*.45,b.y+b.height/2,{steps:24});await pause(250);await locator.click();await pause(500)}
 async function type(text){await editor.pressSequentially(text,{delay:105});await pause(850)}
 async function key(value){await editor.press(value);await pause(350);const hint=page.locator('#demo-key');assert((await hint.innerText()).includes(value));assert(Number.parseFloat(await hint.locator('kbd').evaluate(el=>getComputedStyle(el).fontSize))>=32);await page.screenshot({path:join(output,id+'-'+value+'.png')});await pause(1350)}
 async function settings(){await click(page.getByRole('button',{name:'设置',exact:true}));await click(page.getByRole('button',{name:'引用万物',exact:true}))}
 const start=(Date.now()-epoch)/1000
 await pause(650)
 if(id==='folders'){
  await click(editor);await type('@file:docs');await page.getByRole('option').filter({hasText:'docs'}).first().waitFor()
  await key('Tab');await page.getByRole('navigation',{name:'目录导航'}).waitFor()
  await type('testing');await key('Tab');await pause(700)
  await click(page.getByRole('navigation',{name:'目录导航'}).getByRole('button',{name:'docs',exact:true}))
  await pause(700);await key('Enter');assert((await editor.innerText()).includes('testing'));await type(' 阅读这个目录')
 }else if(id==='local-plugins'){
  await click(editor);await type('@plugin:');await page.getByRole('option').first().waitFor()
  await type('dsh-reference-anything');await page.getByRole('option').filter({hasText:'dsh-reference-anything'}).waitFor();await key('Enter');assert((await editor.innerText()).includes('dsh-reference-anything'));await type(' 看看这个插件的配置')
 }else if(id==='agent-import'){
  await click(editor);await type('@agent:');await page.getByRole('option').filter({hasText:'缓存策略设计'}).waitFor();await key('Enter');assert((await editor.innerText()).includes('缓存策略设计'))
  await editor.press('ControlOrMeta+A');await key('Backspace');await type('@agent:');await key('Tab')
  const confirm=page.getByRole('option').filter({hasText:'确认导入'})
  if(!await confirm.count())await click(page.getByRole('option').filter({hasText:'导入并继续'}).first())
  await click(confirm.first())
  await page.getByText('采用缓存旁路模式：',{exact:false}).waitFor();await pause(1300);await click(editor);await type('接着实现这个方案')
 }else if(id==='chat-import-upgrade'){
  await click(editor);await type('@agent:');await click(page.getByRole('option').filter({hasText:'升级 Chat Import'}));await pause(1800)
  await editor.press('Escape');await settings();await click(page.getByRole('button',{name:'@ 本地 Agent 对话 选择要从本机历史记录中读取、并显示在 @ 候选中的 Agent。',exact:true}))
  const status=page.locator('.dsh_ref_agent_actions').getByText('Chat Import 安装或升级已完成',{exact:false})
  await status.waitFor();await status.scrollIntoViewIfNeeded();await page.mouse.move(850,600,{steps:15});await page.mouse.wheel(0,360);await pause(2200)
 }else if(id==='local-references'){
  await click(editor);await type('@codex:缓存');await page.getByRole('option').filter({hasText:'缓存策略设计'}).waitFor()
  await editor.press('Enter');await pause(1200);assert((await editor.innerText()).includes('缓存策略设计'))
  await type(' @claude-code:接口');await page.getByRole('option').filter({hasText:'接口重构方案'}).waitFor()
  await editor.press('Enter');await pause(1200);assert((await editor.innerText()).includes('接口重构方案'))
  await type(' 对照两段历史讨论，只读分析，不导入会话。');await pause(1800)
 }else if(id==='shortcuts'){
  await settings()
  for(const [source,label,value] of [['agents','本地 Agent 对话','agent, work'],['conversations','网页端 AI 对话','chat, work']]){
   await click(page.getByRole('button',{name:label+' · 快捷短语',exact:true}))
   const input=page.locator(`[data-picker-id="${source}"] .dsh_ref_picker_fields input[type="text"]`)
   await click(input);await input.press('ControlOrMeta+A');await input.pressSequentially(value,{delay:130});await input.press('Tab');await pause(1700)
   await click(page.getByRole('button',{name:label+' · 快捷短语',exact:true}))
  }
  await click(page.getByRole('button',{name:'关闭',exact:true}));await click(editor);await type('@work:缓存')
  await page.getByRole('option').filter({hasText:'缓存失效策略'}).waitFor();await pause(1600)
  await editor.press('ControlOrMeta+A');await type('@codex:缓存');assert.equal(await page.getByRole('option').count(),1);await pause(1000)
 }
 await pause(1000)
 const end=(Date.now()-epoch)/1000
 await page.screenshot({path:join(output,id+'.png')})
 const raw=await page.video().path();await context.close()
 assert.deepEqual(errors,[],`${id}: browser errors`)
 const mp4=join(output,id+'.mp4'),gif=join(output,id+'.gif')
 execFileSync('ffmpeg',['-y','-ss',String(start),'-i',raw,'-t',String(end-start),'-an','-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',mp4],{stdio:'pipe'})
 execFileSync('ffmpeg',['-y','-i',mp4,'-filter_complex','fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4','-loop','0',gif],{stdio:'pipe'})
 const probe=JSON.parse(execFileSync('ffprobe',['-v','quiet','-show_format','-show_streams','-of','json',gif],{encoding:'utf8'}));assert.equal(probe.streams[0].width,960);assert(Number(probe.format.duration)>5)
 results.push({id,title:names[id],duration:Number(probe.format.duration),gif,mp4});console.log(JSON.stringify(results.at(-1)))
 writeFileSync(join(output,'manifest.json'),JSON.stringify(results,null,2))
 writeFileSync(join(output,'index.html'),`<!doctype html><meta charset="utf-8"><title>DSH Web 实录</title><style>body{font-family:sans-serif;background:#f5f6f8;margin:40px auto;max-width:1050px}video{width:100%;border-radius:14px}section{margin-bottom:50px}a{color:#4566dd}</style><h1>DSH Web 实录 · 演示数据</h1><p>真实插件界面与交互；会话、升级服务使用演示替身。旧版 HTML 动画保留。</p>${results.map(r=>`<section><h2>${r.title}</h2><video controls loop muted src="${r.id}.mp4"></video><p><a href="${r.id}.gif">查看 GIF</a></p></section>`).join('')}`)
}}
catch(error){if(activePage&&!activePage.isClosed()){await activePage.screenshot({path:join(output,'failure.png')});writeFileSync(join(output,'failure.txt'),await activePage.locator('body').ariaSnapshot())}throw error}
finally{await browser.close();writeFileSync(join(demo,'mode.json'),JSON.stringify({scene:'folders'}))}
console.log('Gallery: '+join(output,'index.html'))
