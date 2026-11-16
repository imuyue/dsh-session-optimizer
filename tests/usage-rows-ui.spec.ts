import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { textOf } from '../client/i18n.ts'
type Node={type:unknown;props:Record<string,unknown>}
const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props})
function children(value:unknown):Node[]{
 if(Array.isArray(value))return value.flatMap(children)
 if(value===null||typeof value!=='object'||!('props'in value))return []
 const node=value as Node;return [node,...children(node.props.children)]
}
function mount(){
 const fetch=vi.fn(async(_signal:AbortSignal,_options:unknown)=>({usage:[],usageTotal:0})),hydrate=vi.fn(async()=>undefined)
 const slots:unknown[]=[],tasks:Array<()=>void>=[];let cursor=0
 const react={
  useState(initial:unknown){const at=cursor++;if(!(at in slots))slots[at]=initial;return[slots[at],(value:unknown)=>{slots[at]=typeof value==='function'?(value as (old:unknown)=>unknown)(slots[at]):value}]},
  useRef(current:unknown){const at=cursor++;return slots[at]??(slots[at]={current})},
  useEffect(callback:()=>void|(()=>void),deps:unknown[]){const at=cursor++,old=slots[at] as {deps:unknown[];dispose?:()=>void}|undefined;if(!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i]))){tasks.push(()=>{old?.dispose?.();slots[at]={deps,dispose:callback()}})}},
 }
 const code=ts.transpileModule(readFileSync(new URL('../client/UsageRows.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2024,jsx:ts.JsxEmit.ReactJSX}}).outputText
 const module={exports:{} as {UsageRows:(props:unknown)=>Node}}
 runInNewContext(code,{module,exports:module.exports,AbortController,require(id:string){
  if(id==='react')return react
  if(id==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:Symbol.for('fragment')}
  if(id==='@deepseek-ai/dsh-client-ui-primitives')return{fileSizeText:(n:number)=>`${n} B`}
  if(id==='./api.ts')return{fetchOverview:fetch}
  if(id==='./usage-titles.ts')return{hydrateUsageTitles:hydrate}
  throw new Error(id)
 }})
 const props={rows:[{id:'parent',title:'Parent',childCount:2,eventCount:7,sizeBytes:100}],text:textOf('zh'),locale:'zh-CN',totalBytes:900,onMissing:vi.fn()}
 const entry=(module.exports.UsageRows(props).props.children as Node[])[0]!
 const render=()=>{cursor=0;const tree=(entry.type as (props:unknown)=>Node)(entry.props);while(tasks.length)tasks.shift()!();return tree}
 return{render,fetch,hydrate}
}
it('does not fetch hidden children until clicked, then requests only the selected parent',async()=>{
 const test=mount();const first=test.render()
 expect(test.fetch).not.toHaveBeenCalled()
 const button=children(first).find(node=>node.type==='button')!
 expect(button.props['aria-expanded']).toBe(false)
 ;(button.props.onClick as ()=>void)();test.render();await Promise.resolve()
 expect(test.fetch).toHaveBeenCalledTimes(1)
 expect(test.fetch.mock.calls[0]![1]).toEqual({parent:'parent',offset:0,limit:50})
 const tree=test.render()
 const main=children(tree).find(node=>node.props['data-session-id']==='parent')!
 const cells=children(main).filter(node=>node.type==='td')
 expect(cells[1]!.props.children).toBe('7');expect(cells[2]!.props.children).toBe('100 B')
})
it('collapsing cancels the in-flight child request without touching the parent row',()=>{
 const test=mount();let tree=test.render()
 ;(children(tree).find(node=>node.type==='button')!.props.onClick as ()=>void)();tree=test.render()
 const signal=test.fetch.mock.calls[0]![0]
 expect(signal.aborted).toBe(false)
 ;(children(tree).find(node=>node.type==='button')!.props.onClick as ()=>void)();tree=test.render()
 expect(signal.aborted).toBe(true)
 expect(children(tree).find(node=>node.props['data-session-id']==='parent')).toBeDefined()
 expect(children(tree).find(node=>node.type==='button')!.props['aria-expanded']).toBe(false)
})
