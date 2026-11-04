import type { Source, Correction } from './types.ts';

export type SourceSearchResult = {id:string;label:string;originalLabel:string;kind:'tip'|'group'};
export type SourceSearchPage = {results:SourceSearchResult[];total:number;offset:number;limit:number};
// Names are compared locally. Underscores commonly encode spaces in Newick labels.
// Do not infer synonyms, species identities or relationships from a text match.
const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[_\s]+/gu,' ').trim();
export function searchSource(source:Source,query:string,corrections:Correction[]=[],options:{tipsOnly?:boolean;offset?:number;limit?:number}={}):SourceSearchPage {
  const limit=options.limit??25,requested=options.offset??0;
  if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(requested)||requested<0)throw new Error('Invalid source search page.');
  const text=normalize(query),empty={results:[],total:0,offset:0,limit};if(!text)return empty;
  const terms=text.split(' '),corrected=new Map(corrections.map(c=>[c.source_node_id,c.display_taxonomy])),matches:{result:SourceSearchResult;score:number;order:number}[]=[];
  for(let order=0;order<source.order.length;order++){
    const id=source.order[order],node=source.nodes[id],kind=node.children.length?'group':'tip';if(options.tipsOnly&&kind!=='tip')continue;
    const label=(kind==='tip'?corrected.get(id):null)||node.label||(kind==='group'?`Source group ${id}`:id),fields=[id,node.rawLabel,node.label,label].map(normalize);
    if(!terms.every(term=>fields.some(value=>value.includes(term))))continue;
    const score=fields.some(value=>value===text)?0:fields.some(value=>value.startsWith(text))?1:2;
    matches.push({result:{id,label,originalLabel:node.label,kind},score,order});
  }
  matches.sort((a,b)=>a.score-b.score||a.order-b.order);
  const offset=requested<matches.length?requested:0;
  return {results:matches.slice(offset,offset+limit).map(m=>m.result),total:matches.length,offset,limit};
}
