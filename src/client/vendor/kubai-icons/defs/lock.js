import{defineIcon as s,KR as e,f as r,OL as l,rr as a,at as i}from"../kit.js";var c=s({name:"lock",category:"security",tags:["padlock","secure","private","password"],svg:t=>`
    <g data-n="shackle" filter="${t.sh}">
      <path d="M10.5 12V7.6A5 5 0 0 1 20.5 7.6V12" fill="none" stroke-width="3.2" stroke-linecap="round" data-t="stroke:#81B0FF"/>
      <path d="M10.5 12V7.6A5 5 0 0 1 20.5 7.6V12" fill="none" stroke-width="1" stroke-linecap="round" stroke="#fff" stroke-opacity=".45"/>
    </g>
    <g filter="${t.sh}"><g filter="${t.hi}"><path d="${a(5.6,11,19.8,12.6,e)}" fill="${t.upS}"/></g></g>
    <path d="${a(5.6,11,19.8,12.6,e)}" ${l}/>
    <g data-t="fill:#2F6FE0"><circle cx="15.5" cy="16.2" r="2.5"/><path d="${a(14.6,16.6,1.8,4.6,.9)}"/></g>`,target:t=>({sh:t?[-2.4,20]:[0,0]}),draw(t,o){i(o.shackle,{transform:`translate(0 ${r(t.sh[0])}) rotate(${r(t.sh[1])} 20.5 12)`})}});export{c as default};
