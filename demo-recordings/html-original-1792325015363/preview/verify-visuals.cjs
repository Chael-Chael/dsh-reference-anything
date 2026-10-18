const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/27923/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{const b=await chromium.launch({channel:'msedge'}),p=await b.newPage({viewport:{width:960,height:640}});await p.goto('file:///D:/dsh-reference-anything/.codex-tmp/feature-demos/preview.html?capture');await p.waitForFunction(()=>window.demo?.ready);
for(const [id,t] of [['folders',2800],['shortcuts',2000],['shortcuts',4200],['chat-import-upgrade',9000],['agent-import',2000]]){
await p.evaluate(([id,t])=>window.demo.seek(id,t),[id,t]);
assert(await p.locator('.appbar svg').count());
assert(await p.evaluate(()=>document.fonts.check('16px DemoSourceHan')));
if(id==='folders'){const r=await p.locator('.keycap').boundingBox();assert(Math.abs(r.x+r.width/2-480)<2);}
if(id==='shortcuts'){assert(await p.locator('.dsh_ref_settings').count());const r=await p.locator('.real-settings input:focus').boundingBox();console.log(id,t,r);assert(r&&r.y>90&&r.y+r.height<587);}
if(id==='agent-import')assert.equal(await p.locator('[role="option"] .demo-agent-icon').count(),2);
await p.screenshot({path:'.codex-tmp/feature-demos/checked-'+id+'-'+t+'.png'});
}
await b.close();console.log('Logo, font, centered keys, real settings/focus and custom agent icons verified')})().catch(e=>{console.error(e);process.exit(1)})

