import{defineIcon as l,f as c,DEEP as s,DEEPS as h,rr as o,at as i,rattle as p,clamp01 as d}from"../kit.js";import{solid as e,span as f}from"./_devices.js";var g=l({name:"bot",category:"devices",tags:["robot","ai","assistant","chatbot","automation"],variants:["plus","check","x","alert","sparkle","cog","heart","bolt"],svg:t=>`${e(t,o(2.8,11.6,3.6,6.4,1.2),t.upS)}${e(t,o(24.6,11.6,3.6,6.4,1.2),t.upS)}
      <g data-n="ant"><path d="M15.5 7.4V4.4" fill="none" stroke-width="2.2" stroke-linecap="round" ${h}/><circle cx="15.5" cy="3" r="1.8" ${s}/></g>
      ${e(t,o(5.2,7,20.6,15.6,4),t.loS)}
      <path d="${o(8.2,10,14.6,9.6,2.6)}" fill="#fff"/>
      <path data-n="eyes" ${s}/>`,target:t=>({o:t?1:0}),draw(t,r){const n=d(t.o),a=3.8*(1-.75*Math.sin(Math.PI*f(n,0,.5)));i(r.eyes,{d:o(10.8,14.8-a/2,2.8,a,Math.min(1.4,a/2))+o(17.4,14.8-a/2,2.8,a,Math.min(1.4,a/2))}),i(r.ant,{transform:`rotate(${c(p(n,30,2))} 15.5 7.4)`})}});export{g as default};
