import{defineIcon as $,f as e,OL as d,DEEP as h,DEEPS as s,rp as c,circ as l,rattle as g,at as p,clamp01 as n}from"../kit.js";const f=[Math.SQRT1_2,-Math.SQRT1_2],i=[Math.SQRT1_2,Math.SQRT1_2],o=[23,5],a=(t,r)=>[o[0]+f[0]*t+i[0]*r,o[1]+f[1]*t+i[1]*r],S=c([a(-1,0),a(1.4,2.2),a(3,2.2),a(2.2,0),a(3,-2.2),a(1.4,-2.2)],.4);var T=$({name:"target",category:"sports",tags:["goal","aim","dart","bullseye","focus"],variants:["check","star","clock"],svg:t=>`<g filter="${t.sh}"><g filter="${t.hi}"><path d="${l(15.5,12.5,11.5)}" fill="${t.loS}"/></g></g>
    <path d="${l(15.5,12.5,11.5)}" ${d}/>
    <path d="${l(15.5,12.5,8.6)}" fill="#fff"/>
    <g filter="${t.hi}"><path d="${l(15.5,12.5,5.8)}" fill="${t.loS}"/></g>
    <path d="${l(15.5,12.5,2.9)}" fill="#fff"/>
    <g data-n="d"><path d="M15.5 12.5L${e(o[0])} ${e(o[1])}" fill="none" stroke-width="2.2" stroke-linecap="round" ${s}/><path d="${S}" ${h}/></g>`,target:t=>({o:t?1:0}),draw(t,r){p(r.d,{transform:`rotate(${e(g(n(t.o),13,3))} 15.5 12.5)`})}});export{T as default};
