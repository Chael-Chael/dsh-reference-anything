import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync,copyFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright')
const browser=await chromium.launch({channel:'msedge',headless:true})
const output=resolve('.codex-tmp/feature-demos')
const backup=join(output,'previous-'+Date.now())
mkdirSync(backup,{recursive:true})
try {
 const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(pathToFileURL(join(output,'preview.html')).href+'?capture')
 await page.waitForFunction(()=>window.demo?.ready,{}, {timeout:30000})
 const scenes=await page.evaluate(()=>window.demo.scenes)
 assert.equal(scenes.length,5)
 assert(await page.evaluate(()=>document.fonts.check('16px DemoSourceHan')), 'Source Han Sans must load before capture')
 for(const [id,time] of [['folders',2800],['shortcuts',2000],['shortcuts',4200]]){
  await page.evaluate(([id,time])=>window.demo.seek(id,time),[id,time])
  if(id==='folders'){
   const key=await page.locator('.keycap').boundingBox()
   assert(key&&Math.abs(key.x+key.width/2-480)<2,'keyboard overlay must be centered')
  }else{
   const input=await page.locator('.real-settings input:focus').boundingBox()
   assert(input&&input.y>90&&input.y+input.height<587,'focused real settings control must be visible')
  }
 }

 for(const scene of scenes){
  if(process.argv.length>2&&!process.argv.slice(2).includes(scene.id))continue
  const frames=join(output,scene.id+'-motion');mkdirSync(frames,{recursive:true})
  const total=scene.duration*.03
  let previous,changed=0
  for(let frame=0;frame<total;frame++){
   await page.evaluate(({id,time})=>window.demo.seek(id,time),{id:scene.id,time:frame*1000/30+.01})
   if(frame%30===0){
    const bounds=await page.evaluate(()=>({frame:Number(document.querySelector('[data-frame]').dataset.frame),width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}))
    assert.equal(bounds.frame,frame)
    assert(bounds.width<=960&&bounds.height<=640)
   }
   const png=await page.screenshot({path:join(frames,`${String(frame).padStart(4,'0')}.png`)})
   if(previous&&!png.equals(previous))changed++
   previous=png
  }
  assert(changed>total*.35,`${scene.id}: animation is too static`)
  const mp4=join(output,scene.id+'.mp4')
  execFileSync('ffmpeg',['-y','-v','error','-framerate','30','-i',join(frames,'%04d.png'),'-frames:v',String(total),'-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',mp4])
  const gif=resolve('docs/release/0.4.4/demos',scene.id+'.gif')
  if(existsSync(gif))copyFileSync(gif,join(backup,scene.id+'.gif'))
  execFileSync('ffmpeg',['-y','-v','error','-i',mp4,'-filter_complex','[0:v]fps=20,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4','-loop','0',gif])
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=nb_frames,width,height:format=duration','-of','json',gif],{encoding:'utf8'}))
  assert.equal(info.streams[0].width,960);assert.equal(info.streams[0].height,640)
  assert(Math.abs(Number(info.format.duration)-scene.duration/1000)<.15)
  assert(Number(info.streams[0].nb_frames)>scene.duration/100)
  console.log(`${scene.id}: ${total} frames, ${changed} changing frames, GIF verified`)
 }
 assert.deepEqual(errors,[])
 writeFileSync(join(output,'gallery.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH 动效预览</title><style>@font-face{font-family:DemoSourceHan;src:url(../../scripts/feature-demos/vendor/SourceHanSansSC-VF.otf)}body{font:16px DemoSourceHan;margin:30px;background:#f4f5f8;color:#242832}main{max-width:1000px;margin:auto}video{width:100%;border-radius:16px}section{margin-bottom:44px}a{color:#4263de}</style><main><h1>DSH 新功能演示</h1><p>30 fps 视频预览 · GIF 已接入功能卡片。导入和升级使用示例数据。</p>${scenes.map(s=>`<section><h2>${s.title}</h2><video src="${s.id}.mp4" controls loop muted playsinline></video><p><a href="../../docs/release/0.4.4/demos/${s.id}.gif">查看 GIF</a></p></section>`).join('')}</main></html>`)
} finally {await browser.close()}
