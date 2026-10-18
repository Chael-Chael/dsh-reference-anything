const row=(name,description='',icon='session',drill=false)=>({name,description,icon,drill})
const group=(source,items)=>({source,items,status:'ready'})
const agents=[group('本地 Agent 对话',[row('缓存策略设计','Codex · 未导入','codex',true),row('接口重构','Claude Code · 已导入','claude-code',true)])]
const files=[group('文件与文件夹',[row('docs/','','folder',true),row('src/','','folder',true),row('README.md','','text')])]
const docs=[group('文件与文件夹',[row('testing/','','folder',true),row('api.md','','text'),row('guide.md','','text')])]
const testing=[group('文件与文件夹',[row('DSH-0.1.2-rc.1-verification.md','','text'),row('Start-DSH-RC1.ps1','','code'),row('cloud-drive-download-directory.md','','text')])]
const plugins=[group('本地插件',[row('dsh-reference-anything','0.4.4 · 运行中','plugin'),row('dsh-chat-import','运行中','plugin'),row('dsh-claude-style','运行中','plugin')])]
const first='[role="option"]'
export const scenes=[
 {id:'folders',title:'目录浏览与引用',duration:13000,beats:[
  {at:0,query:'@',type:450},
  {at:600,query:'@',groups:files},
  {at:2600,query:'@docs/',groups:docs,crumbs:['工作区','docs'],key:'Tab',slide:1},
  {at:4800,query:'@docs/testing/',groups:testing,crumbs:['工作区','docs','testing'],key:'Tab',slide:1},
  {at:7200,query:'@docs/',groups:docs,crumbs:['工作区','docs'],click:true,slide:-1},
  {at:9500,reference:'docs/testing/',kind:'folder',key:'Enter'},
  {at:10800,reference:'docs/testing/',kind:'folder',query:' 阅读这个目录',type:900}
 ],moves:[{at:0,x:800,y:540},{at:450,target:'.input'},{at:1500,target:first},{at:2500,target:first},{at:3300,target:first},{at:4700,target:first},{at:5600,x:700,y:480},{at:6800,target:'[aria-label="当前位置"] button:nth-of-type(2)'},{at:7350,target:'[aria-label="当前位置"] button:nth-of-type(2)'},{at:8500,target:first},{at:9400,target:first},{at:10300,x:800,y:560}],zoom:[0,0,1.8,1,9.3,1,10.3,0]},
 {id:'agent-import',title:'会话引用与导入',duration:15000,beats:[
  {at:0,query:'@agent:',type:1000},{at:1100,query:'@agent:',groups:agents},
  {at:3000,reference:'缓存策略设计',key:'Enter'},
  {at:4400,key:'⌫'},
  {at:4800,query:'@agent:',type:650},{at:5500,query:'@agent:',groups:agents},
  {at:7100,query:'@agent:',groups:[group('本地 Agent 对话',[row('导入并继续','导入完整历史并打开新会话','import'),row('Resume 并继续','生成交接摘要','summary'),row('返回对话列表','','undo-2')])],key:'Tab',slide:1},
  {at:8800,query:'@agent:',groups:[group('本地 Agent 对话',[row('确认导入并继续','缓存策略设计','import'),row('返回对话列表','','undo-2')])],click:true,slide:1},
  {at:10200,query:'@agent:',groups:[group('本地 Agent 对话',[row('正在导入…','缓存策略设计','import'),row('返回对话列表','','undo-2')])],click:true,busy:true},
  {at:11900,transcript:true},
  {at:13000,transcript:true,query:'接着实现这个方案',type:1100}
 ],moves:[{at:0,x:800,y:540},{at:900,target:'.input'},{at:2000,target:first},{at:2900,target:first},{at:3600,x:790,y:560},{at:6000,target:first},{at:7000,target:first},{at:8100,target:first},{at:8900,target:first},{at:9600,target:first},{at:10300,target:first},{at:11500,x:820,y:550}],zoom:[0,0,2,1,3.8,1,4.6,0,7.6,1,10.8,1,12.1,0]},
 {id:'chat-import-upgrade',title:'升级 Chat Import',duration:12000,simulated:true,beats:[
  {at:0,query:'@agent:',type:900},
  {at:1000,query:'@agent:',groups:[group('本地 Agent 对话',[row('升级 Chat Import','当前版本缺少导入或摘要 API，点击升级','upgrade'),...agents[0].items])]},
  {at:3900,query:'@agent:',groups:[group('本地 Agent 对话',[row('正在升级…','正在通过 DSH 安装 Chat Import','upgrade'),...agents[0].items])],click:true,busy:true},
  {at:8000,settings:true,upgradeResult:true}
 ],moves:[{at:0,x:810,y:540},{at:700,target:'.input'},{at:2700,target:first},{at:4000,target:first},{at:4700,x:770,y:520},{at:8500,x:770,y:520}],zoom:[0,0,2.6,1,10.5,1,11.7,0]},
 {id:'local-plugins',title:'本地插件引用',duration:10000,beats:[
  {at:0,query:'@plugin:',type:1100},{at:1200,query:'@plugin:',groups:plugins},
  {at:2900,query:'@plugin:reference',from:'@plugin:',type:950,groups:plugins},
  {at:3900,query:'@plugin:reference',groups:[group('本地插件',[plugins[0].items[0]])]},
  {at:6200,reference:'dsh-reference-anything/',kind:'plugin',key:'Enter'},
  {at:7600,reference:'dsh-reference-anything/',kind:'plugin',query:' 看看这个插件的配置',type:1100}
 ],moves:[{at:0,x:800,y:540},{at:1000,target:'.input'},{at:2200,x:780,y:530},{at:4700,target:first},{at:6100,target:first},{at:6900,x:820,y:560}],zoom:[0,0,4.4,1,6.8,1,7.5,0]},
 {id:'shortcuts',title:'自定义与共享快捷词',duration:15000,beats:[
  {at:0,settings:true,agent:'agent',web:'chat'},
  {at:1200,settings:true,agent:'agent,work',web:'chat',edit:'agent',from:'agent',type:1200,click:true},
  {at:3500,settings:true,agent:'agent,work',web:'chat,work',edit:'web',from:'chat',type:1100,click:true},
  {at:5200,settings:true,agent:'agent,work',web:'chat,work',shared:true},
  {at:6200,query:'@work:缓存',type:1000},
  {at:7300,query:'@work:缓存',groups:[agents[0],group('网页端 AI 对话',[row('缓存失效策略','ChatGPT','chatgpt'),row('缓存命中率优化','Claude','claude')])]},
  {at:10300,query:'@work:缓存',selection:true,groups:[agents[0],group('网页端 AI 对话',[row('缓存失效策略','ChatGPT','chatgpt'),row('缓存命中率优化','Claude','claude')])]},
  {at:11100,query:'@codex:缓存',replace:true,type:650,groups:[agents[0],group('网页端 AI 对话',[row('缓存失效策略','ChatGPT','chatgpt'),row('缓存命中率优化','Claude','claude')])]},
  {at:12000,query:'@codex:缓存',groups:[group('本地 Agent 对话',[agents[0].items[0]])]}
 ],moves:[{at:0,x:820,y:520},{at:1000,target:'[data-picker-id="agents"] .dsh_ref_picker_fields input[type="text"]'},{at:1400,target:'[data-picker-id="agents"] .dsh_ref_picker_fields input[type="text"]'},{at:3200,x:700,y:225},{at:3700,target:'[data-picker-id="conversations"] .dsh_ref_picker_fields input[type="text"]'},{at:5400,x:820,y:530},{at:6800,target:'.input'},{at:8200,x:830,y:550},{at:10000,target:'.input'},{at:11400,x:830,y:550}],zoom:[0,0,1,1,4.9,1,6,0,8.2,1,13.6,1,14.7,0]}
]
