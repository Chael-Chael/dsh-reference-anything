import {build} from 'esbuild'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
const require=createRequire(import.meta.url)
const uiRequire=createRequire(require.resolve('@deepseek-ai/dsh-client-ui-primitives'))
const rootRequire=createRequire(resolve('package.json'))
const logo='data:image/png;base64,'+readFileSync('images/logo.png').toString('base64')
const mono='data:image/png;base64,'+readFileSync('images/logo-mono.png').toString('base64')
writeFileSync('scripts/feature-demos/vendor/plugin-settings.css',readFileSync('src/client/styles.ts','utf8').split('const css = `')[1].split('`')[0].replaceAll('__REFERENCE_ANYTHING_MONO_LOGO_DATA_URI__',mono))
const result=await build({entryPoints:['scripts/feature-demos/movie.jsx'],bundle:true,jsx:'automatic',format:'esm',loader:{".woff2":"dataurl",".woff":"dataurl",".ttf":"dataurl",".otf":"dataurl",".svg":"text"},write:false,outdir:'.codex-tmp/feature-demos',minify:true,define:{'process.env.NODE_ENV':'"production"'},alias:{clsx:uiRequire.resolve('clsx'),react:resolve(rootRequire.resolve('react'),'..'),'react-dom':resolve(rootRequire.resolve('react-dom'),'..')}})
const js=result.outputFiles.find(f=>f.path.endsWith('.js')).text.replaceAll('__REFERENCE_ANYTHING_LOGO_DATA_URI__',logo)
const css=result.outputFiles.find(f=>f.path.endsWith('.css')).text
const output=resolve('.codex-tmp/feature-demos')
mkdirSync(output,{recursive:true})
writeFileSync(resolve(output,'preview.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DSH 新功能演示</title><style>${css}</style><body><div id="root"></div><script type="module">${js.replaceAll('</script','<\\/script')}</script></body></html>`)
console.log(resolve(output,'preview.html'))
