import type { Point } from '../types.ts';
import type { DisplayGraph, Primitive, RenderScene, SceneLabel, StructuredSettings, TextMeasurements } from './types.ts';
import { layoutCluster, polar, rotatePoint, primitivePoints, labelCorners, sceneRevision } from './layout.ts';
const exact=(object:object,keys:string[])=>!!object&&!Array.isArray(object)&&Object.keys(object).sort().join('|')===keys.sort().join('|');
/** Shared geometry only. Callers determine the meaning of the depth coordinate. */
export function buildSceneFromDepthCoordinates(graph:DisplayGraph,settings:StructuredSettings,measurements:TextMeasurements,positions:Record<string,number>,scale:number,nodes:RenderScene['nodeOffsets']={},labels:RenderScene['labelOffsets']={}):RenderScene{
  // Reuse only the existing ordered slots/sectors; replace every depth coordinate.
  if(!Number.isFinite(settings.innerRadiusMm)||settings.innerRadiusMm<0||settings.innerRadiusMm>1000)throw new Error('Inner radius is outside its supported range.');
  const base=layoutCluster(graph,{...settings,innerRadiusMm:0,orientationDeg:0},measurements,nodes,{}),s={...base.settings,innerRadiusMm:settings.innerRadiusMm,orientationDeg:((settings.orientationDeg%360)+360)%360};
  const spans=new Map(base.junctionGlyphs.map(g=>[g.nodeId,g.span])),center={x:s.widthMm/2,y:s.heightMm/2},coordinates=Object.fromEntries(base.junctionGlyphs.map(g=>[g.nodeId,(g.span[0]+g.span[1])/2+(nodes[g.nodeId]?.shift??0)]));
  const radius=(id:string)=>s.innerRadiusMm+scale*positions[id];
  const anchors=Object.fromEntries(graph.order.map(id=>[id,s.kind==='rectangular'?{x:s.marginMm+scale*positions[id],y:coordinates[id]}:polar(center,radius(id),coordinates[id])]));
  const glyphs:RenderScene['junctionGlyphs']=[],ports:RenderScene['ports']=[],stems:RenderScene['edgeStems']=[],sceneLabels:SceneLabel[]=[];
  for(const id of graph.order){const children=graph.nodes[id].children,anchor=anchors[id];let geometry:Primitive={kind:'point',point:anchor};
    if(children.length>1)geometry=s.kind==='rectangular'?{kind:'polyline',points:[{x:anchor.x,y:anchors[children[0]].y},{x:anchor.x,y:anchors[children.at(-1)!].y}]}:{kind:'arc',center,radius:radius(id),startDeg:coordinates[children[0]],endDeg:coordinates[children.at(-1)!]};
    if(geometry.kind==='arc'&&(!s.curves||geometry.radius===0)){const points=primitivePoints(geometry,s.toleranceMm);geometry=points.length===1?{kind:'point',point:points[0]}:{kind:'polyline',points};}
    glyphs.push({id:`junction-${id}`,nodeId:id,anchor,geometry,span:spans.get(id)!,depth:positions[id]});
    for(const child of children){const edgeId=`display-edge-${child}`,p=s.kind==='rectangular'?{x:anchor.x,y:anchors[child].y}:polar(center,radius(id),coordinates[child]),parentPortId=`${edgeId}-parent`,childPortId=`${edgeId}-child`;
      ports.push({id:parentPortId,nodeId:id,edgeId,end:'parent',point:p},{id:childPortId,nodeId:child,edgeId,end:'child',point:anchors[child]});stems.push({id:`stem-${child}`,edgeId,parentPortId,childPortId,geometry:{kind:'polyline',points:[p,anchors[child]]}});
    }
  }
  for(const id of graph.endpoints){const m=measurements.metrics[id],theta=coordinates[id];let position:Point,rotation=0,anchor:SceneLabel['anchor']='start';
    if(s.kind==='rectangular')position={x:anchors[id].x+s.labelGapMm,y:anchors[id].y+(m.ascentMm-m.descentMm)/2};
    else{position=polar(center,radius(id)+s.labelGapMm,theta);const angle=((theta%360)+360)%360,left=angle>90&&angle<270;
      if(s.labelPlacement==='radial'){rotation=theta+(left?180:0);anchor=left?'end':'start';}else if(s.labelPlacement==='tangential'){rotation=theta+90;const a=((rotation%360)+360)%360;if(a>90&&a<270)rotation+=180;anchor='middle';}else anchor=left?'end':'start';
      const shift=(m.ascentMm-m.descentMm)/2;position={x:position.x-Math.sin(rotation*Math.PI/180)*shift,y:position.y+Math.cos(rotation*Math.PI/180)*shift};
    }
    sceneLabels.push({id:`label-${id}`,nodeId:id,text:m.text,position,rotationDeg:rotation,anchor,corners:[]});
  }
  if(s.orientationDeg){const transform=(p:Point)=>rotatePoint(p,center,s.orientationDeg),primitive=(p:Primitive):Primitive=>p.kind==='point'?{kind:'point',point:transform(p.point)}:p.kind==='polyline'?{kind:'polyline',points:p.points.map(transform)}:{...p,startDeg:p.startDeg+s.orientationDeg,endDeg:p.endDeg+s.orientationDeg};
    for(const g of glyphs){g.anchor=transform(g.anchor);g.geometry=primitive(g.geometry);}for(const p of ports)p.point=transform(p.point);for(const e of stems)e.geometry=primitive(e.geometry);
    for(const l of sceneLabels){l.position=transform(l.position);l.rotationDeg+=s.orientationDeg;if(s.kind!=='rectangular'){const a=((l.rotationDeg%360)+360)%360;if(a>90&&a<270){l.rotationDeg+=180;l.anchor=l.anchor==='start'?'end':l.anchor==='end'?'start':'middle';}}}
  }
  for(const [id,offset]of Object.entries(labels??{}))if(!graph.endpoints.includes(id)||!offset||!exact(offset,['x','y'])||!Number.isFinite(offset.x)||!Number.isFinite(offset.y)||Math.abs(offset.x)>2000||Math.abs(offset.y)>2000)throw new Error('Invalid metric label offset.');
  for(const l of sceneLabels){const offset=labels?.[l.nodeId]??{x:0,y:0};l.position={x:l.position.x+offset.x,y:l.position.y+offset.y};l.corners=labelCorners(l.position,l.rotationDeg,l.anchor,measurements.metrics[l.nodeId]);}
  const points=[...glyphs.flatMap(g=>[g.anchor,...primitivePoints(g.geometry,s.toleranceMm)]),...stems.flatMap(e=>primitivePoints(e.geometry,s.toleranceMm)),...sceneLabels.flatMap(l=>l.corners)];
  const bounds=points.reduce((b,p)=>({minX:Math.min(b.minX,p.x),minY:Math.min(b.minY,p.y),maxX:Math.max(b.maxX,p.x),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
  const scene:RenderScene={...base,revision:'',settings:s,junctionGlyphs:glyphs,edgeStems:stems,ports,labels:sceneLabels,bounds,...(Object.keys(labels??{}).length?{labelOffsets:structuredClone(labels)}:{})};scene.revision=sceneRevision(scene);return scene;
}
