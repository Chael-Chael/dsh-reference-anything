import React, {useLayoutEffect, useRef} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {Player} from '@remotion/player'
import {useCurrentFrame, Easing, interpolate, spring} from 'remotion'
import {Button, Input} from '@deepseek-ai/dsh-client-ui-primitives'
import {MenuView} from './vendor/MenuView.tsx'
import {BrandWordmark} from './vendor/BrandWordmark.tsx'
import {agentLogoElement,ProviderLogo,PickerSourceLogo} from '../../src/client/provider-icons.tsx'
import {ConversationSettings} from '../../src/client/components.tsx'
import {defaultPickerSettings,settingsRecordSchema} from '../../src/wire.ts'
import {zh} from '../../src/client/locale.ts'
import './vendor/plugin-settings.css'
import chip from './vendor/ReferenceChip.module.css'
import {scenes} from './scenes.mjs'
import './vendor/base.css'
import './vendor/design-platform.css'
import './movie.css'

const noop=()=>{}
const store=snapshot=>({getSnapshot:()=>snapshot,subscribe:()=>noop})
const ease=Easing.bezier(.22,.75,.2,1)
const clamp={extrapolateLeft:'clamp',extrapolateRight:'clamp'}
const progress=(time,start,duration)=>interpolate(time,[start,start+duration],[0,1],{...clamp,easing:ease})
const typed=(text,from,elapsed,duration)=>from+text.slice(from.length,from.length+Math.floor(Math.max(0,Math.min(1,elapsed/duration))*(text.length-from.length)))
const translate=key=>({'suggestions.aria':'候选项','crumbs.aria':'当前位置','drill.aria':'进入','drill.hint':'更多操作','drill.key':'Tab',loading:'加载中'}[key]??key)

function Menu({beat,elapsed,outgoing=false}) {
 const ref=useRef(null)
 const groups=(beat.groups??[]).map(group=>({...group,items:group.items.map(item=>({...item,icon:()=> <DemoIcon kind={item.icon}/>}))}))
 useLayoutEffect(()=>{
  ref.current?.querySelectorAll('[role="option"]').forEach((node,i)=>{
   const p=outgoing?1:progress(elapsed,i*45,330)
   node.style.opacity=String(p)
   node.style.translate=`0 ${(1-p)*9}px`
  })
 },[beat,elapsed,outgoing])
 const state={open:!!groups.length,generation:1,groups,highlight:outgoing?null:{source:groups[0]?.source,index:0}}
 const headers=beat.crumbs?new Map([[groups[0]?.source,beat.crumbs.map((label,i)=>({label,current:i===beat.crumbs.length-1}))]]):new Map()
 return <div ref={ref} className={'menu-layer '+(beat.busy?'busy':'')+(beat.success?' success':'')} style={{'--turn':`${elapsed*.28}deg`,opacity:outgoing?1-progress(elapsed,0,280):progress(elapsed,0,220),translate:`${(outgoing?-progress(elapsed,0,280):1-progress(elapsed,0,350))*(beat.slide??1)*18}px 0`}}>
  <MenuView menu={store(state)} headers={store(headers)} onPick={noop} onCrumb={noop} onHover={noop} onDismiss={noop} t={translate}/>
 </div>
}

function DemoIcon({kind,size=16}) {
 if(kind==='codex'||kind==='claude-code')return <span className="demo-agent-icon" data-agent={kind} style={{width:size,height:size}}>{agentLogoElement(kind)}</span>
 if(kind==='chatgpt'||kind==='claude')return <ProviderLogo provider={kind} size={size}/>
 if(kind==='upgrade')return <span>↑</span>
 return <PickerSourceLogo kind={kind} size={size}/>
}
const settingsActions=Object.fromEntries(['save','sync','cancel','refresh','setupAll','discoverOpenCli','installOpenCli','useProfile','install','restartDaemon','checkUpdate','installUpdate','refreshChatImport','upgradeChatImport','browse','deleteConversation','clearProvider','refreshStats'].map(key=>[key,async()=>{}]))
const t=(key,values={})=>Object.entries(values).reduce((text,[key,value])=>text.replaceAll('{'+key+'}',String(value)),zh[key]??key)
function alignSettings(){
 const root=document.querySelector('.real-settings')
 if(!root)return
 const row=root.querySelector(root.dataset.target)
 if(row)root.scrollTop+=(row.getBoundingClientRect().top-root.getBoundingClientRect().top)/.9-18
 const input=row?.querySelector('.dsh_ref_picker_fields input[type="text"]')
 if(input&&root.dataset.edit){input.style.boxShadow='0 0 0 3px #4d6bfe33';input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length)}
}
function Settings({beat,elapsed}) {
 const ref=useRef(null)
 const picker=defaultPickerSettings()
 picker.agents.shortcut=beat.edit==='agent'?typed(beat.agent,beat.from,elapsed,beat.type):(beat.agent??'agent')
 picker.conversations.shortcut=beat.edit==='web'?typed(beat.web,beat.from,elapsed,beat.type):(beat.web??'chat')
 const state={settings:{...settingsRecordSchema.parse({opencliPath:'',profile:'default',detailConcurrency:2}),picker},chatImport:{state:'restart-required',canUpgrade:false}}
 useLayoutEffect(()=>{let id;let remaining=4;const settle=()=>{alignSettings();if(--remaining)id=requestAnimationFrame(settle)};id=requestAnimationFrame(settle);return()=>cancelAnimationFrame(id)},[beat])
 const target=beat.upgradeResult?'.dsh_ref_agent_actions':('[data-picker-id="'+(beat.edit==='web'||beat.shared?'conversations':'agents')+'"]')
 useLayoutEffect(()=>{
  const root=ref.current
  const button=root.querySelector(beat.upgradeResult?'.dsh_ref_agents_section > button':target+' .dsh_ref_picker_expand')
  if(button?.getAttribute('aria-expanded')==='false')button.click()
  const row=root.querySelector(target)
  if(row)root.scrollTop+=(row.getBoundingClientRect().top-root.getBoundingClientRect().top)/.9-18
  const input=row?.querySelector('.dsh_ref_picker_fields input[type="text"]')
  if(input){input.style.boxShadow=beat.edit||beat.shared?'0 0 0 3px #4d6bfe33':'none';if(beat.edit){input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length)}}
 })
 return <div className="real-settings" data-target={target} data-edit={beat.edit} ref={ref}><ConversationSettings {...settingsActions} useScope={select=>select(state)} t={t}/></div>
}

function pointerPosition(scene,time) {
 const i=scene.moves.findLastIndex(p=>time>=p.at)
 const a=scene.moves[Math.max(0,i)],b=scene.moves[Math.min(scene.moves.length-1,i+1)]
 if(a===b)return a
 const p=progress(time,a.at,b.at-a.at)
 return {x:a.x+(b.x-a.x)*p,y:a.y+(b.y-a.y)*p-Math.sin(p*Math.PI)*12}
}

export function Movie({scene}) {
 const time=useCurrentFrame()*1000/30
 const index=scene.beats.findLastIndex(b=>time>=b.at),beat=scene.beats[Math.max(0,index)],before=scene.beats[index-1]
 const elapsed=time-beat.at
 let query=beat.query??''
 if(beat.type)query=beat.replace?'@'+typed('codex','',elapsed,beat.type)+':缓存':typed(query,beat.from??'',elapsed,beat.type)
 const keyBeat=[...scene.beats].reverse().find(b=>b.key&&time>=b.at&&time<b.at+850)
 const click=[...scene.beats].reverse().find(b=>b.click&&time>=b.at&&time<b.at+550)
 const point=pointerPosition(scene,time)
 const clickPoint=click?pointerPosition(scene,click.at):point
 const keyAge=keyBeat?time-keyBeat.at:0
 const zoom=interpolate(time,scene.zoom.filter((_,i)=>i%2===0).map(v=>v*1000),scene.zoom.filter((_,i)=>i%2===1),{...clamp,easing:ease})
 const endOpacity=1-progress(time,scene.duration-350,350)
 const refProgress=spring({frame:elapsed*30/1000,fps:30,config:{damping:22,stiffness:220}})
 return <main className="film" data-frame={Math.round(time*30/1000)} style={{opacity:Math.min(progress(time,0,220),endOpacity)}}>
  <section className="app" style={{scale:1+zoom*.035,transformOrigin:'50% 70%'}}>
   <div className="appbar"><BrandWordmark size={32}/></div>
   {beat.settings?<Settings beat={beat} elapsed={elapsed}/>:<div className="chat">
    {beat.transcript&&<div className="history" style={{opacity:progress(time,11900,450),translate:`0 ${(1-progress(time,11900,500))*16}px`}}><div className="bubble">请帮我设计一个缓存策略。</div><p>可以从缓存键、失效策略和更新机制入手。</p><div className="import-result">✓ 历史消息已导入</div></div>}
    <div className="composer" data-composer-card>
     {before?.groups&&elapsed<280&&<Menu beat={before} elapsed={elapsed} outgoing/>}
     {beat.groups&&<Menu beat={beat} elapsed={elapsed}/>}
     <div className="input">
      {beat.reference&&<span data-reference className={chip.chip} style={{display:'inline-flex',gap:4,opacity:before?.reference===beat.reference?1:refProgress,translate:`0 ${before?.reference===beat.reference?0:(1-refProgress)*12}px`,scale:before?.reference===beat.reference?1:.94+.06*refProgress}}><DemoIcon kind={beat.kind??'codex'} size={17}/><span className={chip.marker}>@</span><span className={chip.label}>{beat.reference}</span></span>}
      <span>{beat.selection?<><span>@</span><mark>work</mark><span>:缓存</span></>:query}</span><span className="caret" style={{opacity:beat.type&&elapsed<beat.type?1:Math.floor(time/500)%2?0:1}}/>
     </div>
     <div className="composer-tools"><span>＋</span><span>工作区内修改</span><span className="model">DeepSeek V4.1 Flash</span><Button size="sm" variant="primary">↑</Button></div>
    </div>
   </div>}
  </section>
  {scene.simulated&&<small className="simulation">升级流程示意</small>}
  {keyBeat&&<div className="keycap" style={{opacity:Math.min(progress(keyAge,0,80),1-progress(keyAge,600,250)),scale:.9+.1*spring({frame:keyAge*.03,fps:30,config:{damping:19,stiffness:280}}),translate:`0 ${(1-progress(keyAge,0,200))*8}px`}}><span>{keyBeat.key}</span><small>⌨</small></div>}
  {click&&<div className="click-ring" style={{left:clickPoint.x,top:clickPoint.y,scale:.3+progress(time,click.at,550)*1.5,opacity:1-progress(time,click.at,550)}}/>}
  <svg className="cursor" viewBox="0 0 28 36" width="28" height="36" style={{left:point.x??800,top:point.y??540,scale:click?1-.12*Math.sin(Math.min(1,(time-click.at)/220)*Math.PI):1}}><path d="M3 2 L3 27 L9 21 L15 33 L20 30 L14 19 L24 18 Z" fill="#171b26" stroke="white" strokeWidth="2.2" strokeLinejoin="round"/></svg>
 </main>
}

const root=createRoot(document.getElementById('root'))
const player=React.createRef()
let active=scenes.find(s=>s.id===new URLSearchParams(location.search).get('demo'))??scenes[0]
const capture=new URLSearchParams(location.search).has('capture')
const raf=()=>new Promise(r=>requestAnimationFrame(r))
function mount(scene){flushSync(()=>root.render(<Player ref={player} component={Movie} inputProps={{scene}} durationInFrames={scene.duration*.03} fps={30} compositionWidth={960} compositionHeight={640} style={{width:960,height:640}} loop controls={false} clickToPlay={false} spaceKeyToPlayOrPause={false}/>))}
async function seek(scene,time){if(active!==scene){active=scene;mount(scene)}player.current.seekTo(Math.min(Math.floor(time*.03),scene.duration*.03-1));await raf();await raf();await raf();await raf();alignSettings()}
mount(active)
await document.fonts.ready
window.demo={scenes:scenes.map(({id,title,duration,beats})=>({id,title,duration,beats:beats.map(({at,key,click})=>({at,key,click}))})),ready:false,async seek(id,time){const scene=scenes.find(s=>s.id===id);if(!scene)throw Error(id);await seek(scene,time)}}
// Resolve cursor targets from the actual official components before playback.
for(const scene of scenes){for(const move of scene.moves){if(!move.target)continue;await seek(scene,move.at);const node=document.querySelector(move.target);if(!node)throw Error(`${scene.id}: missing ${move.target} at ${move.at}`);const rect=node.getBoundingClientRect();move.x=rect.x+Math.min(rect.width*.32,130);move.y=rect.y+rect.height/2}}
const selected=scenes.find(s=>s.id===new URLSearchParams(location.search).get('demo'))??scenes[0]
await seek(selected,0)
window.demo.ready=true
if(!capture)player.current.play()
