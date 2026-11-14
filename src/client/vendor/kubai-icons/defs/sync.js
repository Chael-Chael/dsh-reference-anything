import{defineIcon as c,f as $,OL as r,circ as a,arcArrow as e,at as i}from"../kit.js";const o=e(215,300,4.4),l=e(35,120,4.4);var f=c({name:"sync",category:"arrows",tags:["refresh","reload","update","rotate","cycle"],variants:["alert","check","x","clock"],svg:t=>`
    <g filter="${t.sh}"><g filter="${t.hi}"><path d="${a(15.5,12.5,11.5)}" fill="${t.loS}"/></g></g>
    <path d="${a(15.5,12.5,11.5)}" ${r}/>
    <g filter="${t.hi}"><path d="${a(15.5,12.5,8)}" fill="${t.upS}"/></g>
    <path d="${a(15.5,12.5,8)}" ${r}/>
    <g data-n="arr"><path d="${o.arc}${l.arc}" fill="none" stroke-width="2.2" stroke-linecap="round" data-t="stroke:#2F6FE0"/><path d="${o.head}${l.head}" data-t="fill:#2F6FE0"/></g>`,target:t=>({rot:t?180:0}),draw(t,d){i(d.arr,{transform:`translate(15.5 12.5) rotate(${$(t.rot)})`})}});export{f as default};
