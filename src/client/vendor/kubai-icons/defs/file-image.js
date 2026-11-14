import{defineIcon as e,CR as o,f as p,SOFT as f,rp as h,rr as s,at as l}from"../kit.js";import{typedPage as d,FILE_BADGES as g}from"./_files-text.js";const n=s(9,9.4,13,10.8,o),r=t=>h([[8,21+t],[8,19.6+t],[13.2,15+t],[19,21+t]],[0,0,1.4,0]),c=t=>h([[11.6,21+t],[17.6,13.4+t],[24,21+t]],[0,1.4,0]);var u=e({name:"file-image",category:"files",tags:["image","picture","photo","jpg","png"],variants:g,svg:t=>d(t,`<clipPath id="${t.id("pic")}"><path d="${n}"/></clipPath>
    <path d="${n}" fill="#fff"/>
    <g clip-path="url(#${t.id("pic")})">
      <circle data-n="sun" cx="13" r="1.8" ${f}/>
      <path data-n="h0" d="${r(0)}" fill="${t.loS}"/>
      <path data-n="h1" d="${c(0)}" fill="${t.pure("#5393FF")}"/>
    </g>`),target:t=>({sun:t?1:0}),draw(t,i){const a=Math.max(0,Math.min(1,t.sun));l(i.h0,{d:r(.9*a)}),l(i.h1,{d:c(1.1*a)}),l(i.sun,{cx:p(13+2*a),cy:p(15.2-3.4*Math.sin(Math.PI/2*a)),r:p(1.8+.5*a)})}});export{u as default};
