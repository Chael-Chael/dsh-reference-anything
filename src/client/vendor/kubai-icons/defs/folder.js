import{defineIcon as c,KR as r,f as d,OL as e,LINE as i,rp as l,rr as s,at as f}from"../kit.js";const g=[r,1.4,1.4,r,r,r];var p=c({name:"folder",category:"files",tags:["directory","open","files"],variants:["plus","minus","check","x","alert","info","up","down","right","clock","star","heart","lock","search","sync","cog","sparkle","bolt"],svg:t=>`
    <g filter="${t.sh}"><path data-n="back" fill="${t.lo(21)}"/></g>
    <path data-n="backO" ${e}/>
    <g data-n="file"><path d="${s(0,0,17,9,1)}" fill="#fff"/><path d="M5.5 2.3H11.5" ${i} stroke-width="1"/></g>
    <g filter="${t.hi}"><path data-n="front" fill="${t.up(18)}"/></g>
    <path data-n="frontO" ${e}/>`,target:t=>({back:t?[[4,3],[11.2,3],[14.2,6],[27,6],[27.6,23],[4.6,23]]:[[4,2],[11.2,2],[14.2,5],[27,5],[27,23],[4,23]],fx:t?7.9:7,front:t?[[6.8,13],[29.3,13],[27.6,23],[5.4,23]]:[[4,5],[27,5],[27,23],[4,23]],fr:t?1.8:r}),draw(t,a){const o=l(t.back,g),n=l(t.front,t.fr);f(a.back,{d:o}),f(a.backO,{d:o}),f(a.file,{transform:`translate(${d(t.fx)} 9)`}),f(a.front,{d:n}),f(a.frontO,{d:n})}});export{p as default};
