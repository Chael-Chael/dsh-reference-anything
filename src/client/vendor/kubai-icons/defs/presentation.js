import{defineIcon as h,KR as l,CR as i,R as m,rp as g,rr as e,at as b,clamp01 as d}from"../kit.js";import{back as k,front as E}from"./_commerce-charts.js";const c=[10.6,14.2,17.8],n=[2.6,3.8,5],M=[4.2,5.2,5.8];var R=h({name:"presentation",category:"charts",tags:["slides","board","present","report","meeting","whiteboard"],variants:["plus","check","search"],svg:t=>`<path d="M15.5 16V22.6M15.5 16L10.6 22.6M15.5 16L20.4 22.6" fill="none" stroke-width="2.2" stroke-linecap="round" data-t="stroke:#2F6FE0"/>
    ${k(t,e(5.2,3.2,20.6,14,l),t.loS)}
    <path d="${e(7.8,7.4,15.4,7.6,i)}" fill="#fff"/>
    ${c.map((s,o)=>`<path data-n="b${o}" data-t="fill:#2F6FE0"/>`).join("")}
    ${E(t,e(3.8,1.4,23.4,3.2,1.6),t.upS)}`,target:t=>({o:t?1:0}),draw(t,s){const o=d(t.o);c.forEach((f,a)=>{const r=d(o*1.16-a*.08),p=r?(n[a]+(M[a]-n[a])*r)*(1-.95*Math.sin(Math.PI*r)):n[a];b(s["b"+a],{d:g(m(f,13.6-p,2.6,p),[.6,.6,.2,.2])})})}});export{R as default};
