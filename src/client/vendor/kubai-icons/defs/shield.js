import{defineIcon as g,f as a,OL as e,at as i}from"../kit.js";const r="M15.5 1.4L24.2 4.8V11.4C24.2 17.2 20.6 21.6 15.5 23.8C10.4 21.6 6.8 17.2 6.8 11.4V4.8Z",s="M15.5 5.2L20.6 7.2V11.6C20.6 15.4 18.6 18.2 15.5 19.8C12.4 18.2 10.4 15.4 10.4 11.6V7.2Z";var n=g({name:"shield",category:"security",tags:["protect","security","safe","defense","guard"],variants:["plus","minus","x","alert","info","lock","star","bolt"],svg:t=>`<g data-n="g">
      <g filter="${t.sh}"><g filter="${t.hi}"><path d="${r}" fill="${t.loS}"/></g></g>
      <path d="${r}" ${e}/>
      <g filter="${t.hi}"><path d="${s}" fill="${t.upS}"/></g>
      <path d="${s}" ${e}/>
    </g>`,target:t=>({y:t?-1:0,s:t?1.06:1}),draw(t,l){i(l.g,{transform:`translate(15.5 ${a(12.6+t.y)}) scale(${a(t.s)}) translate(-15.5 -12.6)`})}});export{n as default};
