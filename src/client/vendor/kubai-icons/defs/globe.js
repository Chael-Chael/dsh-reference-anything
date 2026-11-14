import{defineIcon as l,f as e,OL as i,circ as o,at as c}from"../kit.js";var g=l({name:"globe",category:"travel",tags:["world","earth","internet","language","web"],variants:["lock","search","check","x","alert","clock","cog"],off:!0,svg:t=>{const r=o(15.5,12.5,11.5);return`<clipPath id="${t.id("gl")}"><path d="${r}"/></clipPath>
      <g filter="${t.sh}"><g filter="${t.hi}"><path d="${r}" fill="${t.loS}"/></g></g>
      <g clip-path="url(#${t.id("gl")})" fill="none" stroke-width="1.6" stroke="#fff" data-w="stroke">
        <path d="M3 12.5H28"/><path data-n="mer"/>
      </g>
      <path d="${r}" ${i}/>`},target:t=>({rx:t?8.6:4.6}),draw(t,r){const a=t.rx;c(r.mer,{d:`M${e(15.5-a)} 12.5A${e(a)} 11.5 0 1 0 ${e(15.5+a)} 12.5A${e(a)} 11.5 0 1 0 ${e(15.5-a)} 12.5Z`})}});export{g as default};
