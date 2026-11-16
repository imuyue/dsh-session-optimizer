import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { sourceBadge } from '../client/transfer-contract.ts'
import { textOf } from '../client/i18n.ts'
type Node={type:unknown;props:Record<string,unknown>}
const jsx=(type:unknown,props:Record<string,unknown>):Node=>({type,props})
function nodes(value:unknown):Node[]{if(Array.isArray(value))return value.flatMap(nodes);if(value===null||typeof value!=='object'||!('props'in value))return[];const node=value as Node;return[node,...nodes(node.props.children)]}
function mount(){
 const fetch=vi.fn(async(_options:unknown,_signal:AbortSignal)=>({backend:'jsonl',root:'/root',offset:0,limit:50,total:51,sessions:[{id:'child',title:'Child',childCount:0,eventCount:9,sizeBytes:200}]})),toggle=vi.fn()
 const titles=vi.fn(async(_rows:unknown,_signal:AbortSignal,_publish:(rows:unknown[])=>void,_root:string)=>{})
 const states=new Map<string,unknown[]>();let active:unknown[]=[],cursor=0;const tasks:Array<()=>void>=[]
 const react={useState(initial:unknown){const scope=active,at=cursor++;if(!(at in scope))scope[at]=initial;return[scope[at],(value:unknown)=>{scope[at]=typeof value==='function'?(value as(old:unknown)=>unknown)(scope[at]):value}]},useEffect(callback:()=>void|(()=>void),deps:unknown[]){const scope=active,at=cursor++,old=scope[at]as{deps:unknown[];dispose?:()=>void}|undefined;if(!old||deps.some((dep,i)=>!Object.is(dep,old.deps[i])))tasks.push(()=>{old?.dispose?.();scope[at]={deps,dispose:callback()}})}}
 const code=ts.transpileModule(readFileSync(new URL('../client/TransferSessionRows.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2024,jsx:ts.JsxEmit.ReactJSX}}).outputText
 const module={exports:{}as{TransferSessionRows:(props:unknown)=>Node}}
 runInNewContext(code,{module,exports:module.exports,AbortController,require(id:string){if(id==='react')return react;if(id==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:Symbol.for('fragment')};if(id==='@deepseek-ai/dsh-client-ui-primitives')return{fileSizeText:(n:number)=>`${n} B`};if(id==='./transfer-contract.ts')return{sourceBadge};if(id==='./api.ts')return{fetchSource:fetch};if(id==='./session-titles.ts')return{hydrateSessionTitles:titles};throw Error(id)}})
 const props={rows:[{id:'parent',title:'Parent',childCount:51,eventCount:7,sizeBytes:100}],backend:'jsonl',root:'/root',targetLabel:'SQLite',picked:[],onToggle:toggle,text:textOf('zh'),locale:'zh-CN'}
 const component=(props:unknown)=>{active=states.get('list')??[];states.set('list',active);cursor=0;const tree=module.exports.TransferSessionRows(props);while(tasks.length)tasks.shift()!();return tree}
  const first=(component(props).props.children as Node[])[0]!
 const render=(entry:Node=first)=>{const id=(entry.props.row as{id:string}).id;active=states.get(id)??[];states.set(id,active);cursor=0;const tree=(entry.type as(props:unknown)=>Node)(entry.props);while(tasks.length)tasks.shift()!();return tree}
 const expand=(tree:Node)=>{const stop=vi.fn();(nodes(tree).find(n=>n.props['aria-expanded']!==undefined)!.props.onClick as(e:unknown)=>void)({stopPropagation:stop});expect(stop).toHaveBeenCalledOnce()}
 return{render,expand,fetch,toggle,component:module.exports.TransferSessionRows,renderList:component,props,titles}
}
it('expanding never selects a parent or child, and each checkbox addresses only its own id',async()=>{
 const test=mount();let tree=test.render();expect(test.fetch).not.toHaveBeenCalled();test.expand(tree);tree=test.render();await Promise.resolve();tree=test.render()
 expect(test.fetch.mock.calls[0]![0]).toEqual({backend:'jsonl',root:'/root',parent:'parent',offset:0,limit:50});expect(test.toggle).not.toHaveBeenCalled()
 const parent=nodes(tree).find(n=>n.props['data-session-id']==='parent')!
 const cells=nodes(parent).filter(n=>n.type==='td');expect(cells[2]!.props.children).toBe('7');expect(cells[3]!.props.children).toBe('100 B')
 ;(nodes(parent).find(n=>n.type==='input')!.props.onChange as()=>void)();expect(test.toggle.mock.calls).toEqual([['parent']])
 const branch=nodes(tree).find(n=>n.type===test.component)!,child=(test.renderList(branch.props).props.children as Node[])[0]!
 const childTree=test.render(child);(nodes(childTree).find(n=>n.type==='input')!.props.onChange as()=>void)();expect(test.toggle.mock.calls).toEqual([['parent'],['child']])
})
it('paginates children independently and cancels old work on page change and collapse',async()=>{
 const test=mount();let tree=test.render();test.expand(tree);tree=test.render();await Promise.resolve();tree=test.render()
 const firstSignal=test.fetch.mock.calls[0]![1],next=nodes(tree).filter(n=>n.type==='button'&&n.props['aria-expanded']===undefined).at(-1)!
 ;(next.props.onClick as()=>void)();tree=test.render();expect(firstSignal.aborted).toBe(true)
 expect(test.fetch.mock.calls[1]![0]).toMatchObject({parent:'parent',offset:50,limit:50})
 const lastSignal=test.fetch.mock.calls[1]![1];test.expand(tree);test.render();expect(lastSignal.aborted).toBe(true);expect(test.toggle).not.toHaveBeenCalled()
})

it('renders actual source format independently from a copy in the opposite backend',()=>{
 const test=mount()
 const rows=[{...test.props.rows[0]!,inTarget:true}]
 const first=test.renderList({...test.props,rows})
 let tree=test.render((first.props.children as Node[])[0]!)
 let badges=nodes(tree).filter(node=>node.props.className==='dshsql-badge')
 expect(badges.map(node=>node.props.children)).toEqual(['当前格式：JSONL','SQLite 库已有对应对话或副本'])
 const next=test.renderList({...test.props,rows,backend:'sqlite',targetLabel:'JSONL'})
 tree=test.render((next.props.children as Node[])[0]!)
 badges=nodes(tree).filter(node=>node.props.className==='dshsql-badge')
 expect(badges.map(node=>node.props.children)).toEqual(['当前格式：SQLite','JSONL 库已有对应对话或副本'])
})

it('uses shared title batches and ignores results after the page changes',()=>{
 const test=mount(), signal=test.titles.mock.calls[0]![1], publish=test.titles.mock.calls[0]![2]
 expect(test.titles.mock.calls[0]![3]).toBe('/root')
 publish([{...test.props.rows[0],title:'Latest parent'}])
 let list=test.renderList(test.props),item=(list.props.children as Node[])[0]!
 expect((item.props.row as {title:string}).title).toBe('Latest parent')
 const next={...test.props,rows:[{...test.props.rows[0]!,id:'other',title:'Other'}]}
 test.renderList(next);expect(signal.aborted).toBe(true)
 publish([{...test.props.rows[0],title:'Late title'}])
 list=test.renderList(next);item=(list.props.children as Node[])[0]!
 expect((item.props.row as {id:string;title:string})).toMatchObject({id:'other',title:'Other'})
 expect(test.toggle).not.toHaveBeenCalled()
})
