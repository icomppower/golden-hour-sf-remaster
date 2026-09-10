// ============================================================================
//  city_to_json.mjs — upstream world extraction
//  ---------------------------------------------------------------------------
//  Runs cities/san_francisco.js build() under the REAL three.js in Node with a
//  headless document stub, then serialises every static object it puts in the
//  scene. Because the upstream RNG stream is consumed in the same order, the
//  extracted world is bit-identical to what the browser build produces — road
//  ribbons, building placement, tree scatter, landmark geometry, all of it.
//
//  Emits:
//    build/city.json   — object descriptors, materials, instance tables, D
//    build/city.bin    — packed float32/uint32 payloads referenced by city.json
//    src/sim/sf_terrain.generated.js — terrain/bridge/switchback functions,
//                        sliced verbatim from upstream so runtime physics and
//                        the Blender build agree on ground height exactly.
//
//  Upstream: icomppower/sf-sunset-drive @ 8fa56535ffde138a17b2885de9ee53f0c054f005
// ============================================================================
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM_SHA = '8fa56535ffde138a17b2885de9ee53f0c054f005';
const CITY_SRC = path.join(ROOT, 'cities/san_francisco.js');

// ---------- headless canvas stub (facade/sign textures still burn RNG) -------
const ctx2d = new Proxy({}, {get:(_,k)=>{
  if (k === 'measureText') return () => ({width:10});
  if (k === 'createLinearGradient') return () => ({addColorStop(){}});
  if (k === 'getImageData') return (x,y,w,h) => ({data:new Uint8ClampedArray(w*h*4)});
  return () => {};
}, set:()=>true});
globalThis.document = {createElement:(t)=>({width:1,height:1,getContext:()=>ctx2d,
  style:{}, tagName:String(t).toUpperCase()})};
globalThis.window = {devicePixelRatio:1, addEventListener(){}, innerWidth:1920, innerHeight:1080};

// ---------- engine helpers, verbatim from upstream engine.js @ 8fa5653 -------
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
let _seed=1337;
const rand=()=>{_seed=(_seed*1103515245+12345)&0x7fffffff;return _seed/0x7fffffff;};
const rr=(a,b)=>a+rand()*(b-a);
const pick=arr=>arr[(rand()*arr.length)|0];
const winTexPool=[];
function windowTex(cols,rows,base,lit){
  const c=document.createElement('canvas');c.width=cols*16;c.height=rows*16;const x=c.getContext('2d');
  x.fillStyle=base;x.fillRect(0,0,c.width,c.height);
  for(let r=0;r<rows;r++)for(let cc=0;cc<cols;cc++){const on=rand()<0.34;x.fillStyle=on?lit:'rgba(20,26,40,0.9)';x.fillRect(cc*16+3,r*16+3,10,11);}
  const t=new THREE.CanvasTexture(c);t.anisotropy=4;return t;
}
function buildCar(color){
  const g=new THREE.Group();
  const body=new THREE.Mesh(new THREE.BoxGeometry(2.1,0.9,4.4),new THREE.MeshStandardMaterial({color,roughness:0.35,metalness:0.5}));
  body.position.y=0.75;body.castShadow=true;g.add(body);
  const cabin=new THREE.Mesh(new THREE.BoxGeometry(1.8,0.7,2.2),new THREE.MeshStandardMaterial({color:0x1a1e28,roughness:0.2,metalness:0.4,emissive:0x0a0c14}));
  cabin.position.set(0,1.35,-0.2);cabin.castShadow=true;g.add(cabin);
  const wheelG=new THREE.CylinderGeometry(0.5,0.5,0.4,12);const wheelM=new THREE.MeshStandardMaterial({color:0x111111,roughness:0.8});
  const wheels=[];
  for(const[wx,wz]of[[-1,1.4],[1,1.4],[-1,-1.4],[1,-1.4]]){
    const w=new THREE.Mesh(wheelG,wheelM);w.rotation.z=Math.PI/2;w.position.set(wx,0.5,wz);w.castShadow=true;g.add(w);
    wheels.push({front:wz>0,spin:w});
  }
  const hl=new THREE.Mesh(new THREE.SphereGeometry(0.18,8,8),new THREE.MeshBasicMaterial({color:0xfff2c8}));hl.position.set(-0.6,0.7,2.25);g.add(hl);
  const hr=hl.clone();hr.position.x=0.6;g.add(hr);
  const tl=new THREE.Mesh(new THREE.SphereGeometry(0.16,8,8),new THREE.MeshBasicMaterial({color:0xff2a1a}));tl.position.set(-0.6,0.7,-2.25);g.add(tl);
  const tr=tl.clone();tr.position.x=0.6;g.add(tr);
  g.userData.__dynamic=true;
  return {group:g,wheels};
}
const trunkMat=new THREE.MeshStandardMaterial({color:0x8a6a44,roughness:1});
const frondMat=new THREE.MeshStandardMaterial({color:0x3f7a35,roughness:0.9,side:THREE.DoubleSide});
function palm(x,z,s=1,parent){
  const g=new THREE.Group();
  const th=rr(9,15)*s;
  const trunk=new THREE.Mesh(new THREE.CylinderGeometry(0.35*s,0.6*s,th,7),trunkMat);trunk.position.y=th/2;trunk.castShadow=true;g.add(trunk);
  const crown=new THREE.Group();crown.position.y=th;const fGeo=new THREE.PlaneGeometry(1.6*s,7*s);
  for(let i=0;i<9;i++){const f=new THREE.Mesh(fGeo,frondMat);const a=i/9*Math.PI*2;f.position.set(Math.cos(a)*2.4*s,-0.3,Math.sin(a)*2.4*s);f.rotation.set(-0.9,a,0);f.castShadow=true;crown.add(f);}
  g.add(crown);g.position.set(x,0.5,z);parent.add(g);return g;
}

// ---------- slice the D data literal + terrain functions out of upstream -----
const src = fs.readFileSync(CITY_SRC, 'utf8');
function sliceBraced(text, startMarker){
  const i = text.indexOf(startMarker);
  if (i < 0) throw new Error(`upstream shape changed: "${startMarker}" not found`);
  let j = text.indexOf('{', i), depth = 0, k = j;
  for (; k < text.length; k++){
    const c = text[k];
    if (c === '{') depth++;
    else if (c === '}'){ depth--; if (depth === 0) break; }
  }
  return text.slice(j, k+1);
}
function sliceLines(text, fromMarker, toMarker){
  const a = text.indexOf(fromMarker), b = text.indexOf(toMarker, a);
  if (a < 0 || b < 0) throw new Error(`upstream shape changed: ${fromMarker} .. ${toMarker}`);
  return text.slice(a, b);
}
const D_LITERAL   = sliceBraced(src, 'const D={');
const TERRAIN_SRC = sliceLines(src, '    const C=D.coast,', '    // ---- terrain mesh');
const D = (0, eval)('(' + D_LITERAL + ')');

// ---------- run the upstream build ------------------------------------------
// Landmark identity is TAGGED, not inferred. The upstream landmark loop is
// rewritten in a throwaway copy of the module so each mesh records which
// D.landmarks entry built it; guessing from proximity got adjacent landmarks
// (Fisherman's Wharf vs the Lombard marker, the bottle's letters vs the
// stadium) wrong, and every downstream asset inherits that mistake.
const LM_LOOP = "for(const o of D.landmarks){const fn=o.type==='custom'?o.build:LIB[o.type];if(fn)fn(o,ctx);}";
const LM_LOOP_TAGGED = "for(let __i=0;__i<D.landmarks.length;__i++){const o=D.landmarks[__i];" +
  "const __n=LG.children.length;const fn=o.type==='custom'?o.build:LIB[o.type];if(fn)fn(o,ctx);" +
  "for(let __k=__n;__k<LG.children.length;__k++)LG.children[__k].userData.__lm=__i;}";
if (!src.includes(LM_LOOP)) throw new Error('upstream shape changed: landmark loop not found');
const instrumented = path.join(ROOT, 'build/.san_francisco.instrumented.mjs');
fs.writeFileSync(instrumented, src.replace(LM_LOOP, LM_LOOP_TAGGED));
const {CITY} = await import(instrumented + '?t=' + Date.now());
if (CITY.seed !== 1337) throw new Error('seed changed upstream');
const scene = new THREE.Scene();
// engine.js adds its ground plane before CITY.build(); it consumes no RNG.
const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(6000,6000),
  new THREE.MeshStandardMaterial({color:CITY.theme.ground,roughness:1}));
groundPlane.rotation.x = -Math.PI/2; groundPlane.position.y = -0.05; groundPlane.receiveShadow = true;
groundPlane.userData.__kind = 'ground_plane'; scene.add(groundPlane);

const api = {THREE, scene, renderer:null, rand, rr, pick, clamp, lerp,
  buildCar, windowTex, palm, winTexPool, registerBeacon:()=>{}};
const world = CITY.build(api);
// Resolve the whole hierarchy once. Calling updateMatrixWorld on a leaf only
// composes it against whatever its parent's matrixWorld happens to hold, so
// nested groups (the windmill's rotor, the wharf's pier) came out at the
// group's local origin instead of their real world position.
scene.updateMatrixWorld(true);

// ---------- binary packer ----------------------------------------------------
const chunks = []; let byteLen = 0;
function pack(typedArray){
  const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const pad = (4 - (byteLen % 4)) % 4;
  if (pad){ chunks.push(Buffer.alloc(pad)); byteLen += pad; }
  const off = byteLen; chunks.push(buf); byteLen += buf.length;
  return {off, count:typedArray.length, type:typedArray.constructor.name};
}

function BIN_VIEW(desc){
  const buf = Buffer.concat(chunks);
  const t = {'Float32Array': Float32Array, 'Uint32Array': Uint32Array}[desc.type];
  return new t(buf.buffer, buf.byteOffset + desc.off, desc.count);
}
let out_carve = null;

// ---------- serialisation ----------------------------------------------------
const hex = c => c ? '#' + c.getHexString() : null;
function matDesc(m){
  if (!m) return null;
  return {
    type: m.type,
    color: hex(m.color),
    emissive: hex(m.emissive),
    emissiveIntensity: m.emissiveIntensity ?? 0,
    roughness: m.roughness ?? 1,
    metalness: m.metalness ?? 0,
    opacity: m.opacity ?? 1,
    transparent: !!m.transparent,
    doubleSide: m.side === THREE.DoubleSide,
    vertexColors: !!m.vertexColors,
    hasMap: !!m.map,
    hasEmissiveMap: !!m.emissiveMap,
    envMapIntensity: m.envMapIntensity ?? 1,
  };
}
function geoDesc(g){
  const out = {type:g.type, parameters:g.parameters ?? null, groups:g.groups?.length ? g.groups : null};
  const pos = g.attributes.position;
  out.position = pack(pos.array instanceof Float32Array ? pos.array : Float32Array.from(pos.array));
  if (g.attributes.normal) out.normal = pack(Float32Array.from(g.attributes.normal.array));
  if (g.attributes.uv)     out.uv     = pack(Float32Array.from(g.attributes.uv.array));
  if (g.attributes.color)  out.color  = pack(Float32Array.from(g.attributes.color.array));
  if (g.index)             out.index  = pack(Uint32Array.from(g.index.array));
  out.vertexCount = pos.count;
  return out;
}

const objects = [], dynamic = [];
let nextId = 0;
function isDynamicRoot(o){
  if (o.userData.__dynamic) return true;
  // cable cars build their own Group inline; identify by body box signature
  if (o.isGroup) for (const c of o.children)
    if (c.isMesh && c.geometry.type === 'BoxGeometry'){
      const p = c.geometry.parameters;
      if (Math.abs(p.width-2.5)<1e-6 && Math.abs(p.height-1.7)<1e-6 && Math.abs(p.depth-5.4)<1e-6) return true;
    }
  return false;
}
function emit(o, kind, landmarkIdx){
  o.updateMatrixWorld(true);
  const rec = {
    id: nextId++, kind, name: o.name || null,
    landmark: landmarkIdx ?? null,
    matrix: o.matrixWorld.elements.slice(),
    castShadow: !!o.castShadow, receiveShadow: !!o.receiveShadow,
    geometry: geoDesc(o.geometry),
    material: Array.isArray(o.material) ? o.material.map(matDesc) : matDesc(o.material),
  };
  if (o.isInstancedMesh){
    rec.instances = {count:o.count, matrices: pack(Float32Array.from(o.instanceMatrix.array))};
    if (o.instanceColor) rec.instances.colors = pack(Float32Array.from(o.instanceColor.array));
  }
  objects.push(rec);
  return rec;
}

// The scene is walked in add() order; kinds are asserted structurally so any
// upstream reshape fails the build loudly instead of silently mis-baking.
const roots = scene.children;
const LG = roots.find(o => o.isGroup && !isDynamicRoot(o) && o.children.length > 20);
if (!LG) throw new Error('landmark group not found');

const LMS = D.landmarks;
let staticIdx = 0;
const KIND_ORDER = ['ground_plane','terrain','water','roads','road_dashes','lamp_pole','lamp_head','buildings','trees'];
for (const o of roots){
  if (o === LG){
    for (const child of LG.children){
      const li = child.userData.__lm;
      if (li == null) throw new Error('landmark tag missing — instrumentation failed');
      child.traverse(m => { if (m.isMesh || m.isInstancedMesh) emit(m, 'landmark', li); });
    }
    continue;
  }
  if (isDynamicRoot(o)){
    dynamic.push({type:'car', children:o.children.length});
    continue;
  }
  if (o.isMesh || o.isInstancedMesh){
    let kind;
    if (staticIdx < KIND_ORDER.length) kind = KIND_ORDER[staticIdx];
    else kind = (staticIdx === KIND_ORDER.length) ? 'lombard' : 'bridge';
    staticIdx++;
    emit(o, kind);
  } else if (o.isGroup){
    o.traverse(m => { if (m.isMesh) emit(m, 'misc'); });
  }
}

// structural assertions — these are the divergence tripwires
const kindCount = k => objects.filter(o => o.kind === k).length;
const assert = (c, msg) => { if (!c) throw new Error('EXTRACT ASSERT: ' + msg); };
assert(kindCount('terrain') === 1, 'expected exactly 1 terrain mesh');
assert(kindCount('water') === 1, 'expected exactly 1 water plane');
assert(kindCount('roads') === 1, 'expected exactly 1 road mesh');
assert(kindCount('buildings') === 1, 'expected exactly 1 building InstancedMesh');
assert(kindCount('trees') === 1, 'expected exactly 1 tree InstancedMesh');
assert(kindCount('lombard') === 1, 'expected exactly 1 switchback road mesh');
assert(kindCount('bridge') > 20, 'expected bridge meshes');
assert(kindCount('landmark') > 100, 'expected landmark meshes');
const bld = objects.find(o => o.kind === 'buildings');
assert(bld.instances.count > 200, 'building instance count collapsed');

// ---------- landmark manifest ------------------------------------------------
// Tripwire: a landmark whose meshes sit far from its own coordinate means the
// segmentation drifted, and every downstream asset would be authored wrong.
for (let i = 0; i < LMS.length; i++){
  const own = objects.filter(ob => ob.landmark === i);
  if (!own.length) continue;
  const cx = own.reduce((a, ob) => a + ob.matrix[12], 0) / own.length;
  const cz = own.reduce((a, ob) => a + ob.matrix[14], 0) / own.length;
  const d = Math.hypot(cx - LMS[i].x, cz - LMS[i].z);
  if (d > 30) console.warn(`  WARN landmark ${LMS[i].type} centroid is ${d.toFixed(1)} m from its coordinate`);
}
const landmarkGroups = LMS.map((o, i) => ({
  index:i, type:o.type, label:o.label, x:o.x, z:o.z,
  clear:o.clear ?? null,
  objects: objects.filter(ob => ob.landmark === i).map(ob => ob.id),
}));

// ---------- terrain carve ---------------------------------------------------
// The upstream terrain mesh is built from terrainH, but the car drives on
// groundH — and groundH cuts the Lombard switchback 56 m into the hill. The
// road ribbon is therefore buried and the car drives inside the hillside.
// Carve the switchback (and only the switchback: groundH also raises ground to
// bridge-deck height, which would wall in the bridges) into the baked terrain
// so the visible ground is the surface the physics uses.
{
  const terr = await import(path.join(ROOT, 'src/sim/sf_terrain.generated.js') + '?t=' + Date.now());
  const rec = objects.find(o => o.kind === 'terrain');
  const arr = new Float32Array(BIN_VIEW(rec.geometry.position));
  let carved = 0, deepest = 0;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i+1], z = arr[i+2];
    const L = terr.switchHeight(x, z);
    if (!L) continue;
    const ny = y + (L.y - y) * L.blend;
    if (Math.abs(ny - y) > 0.01) { carved++; deepest = Math.max(deepest, y - ny); }
    arr[i+1] = ny;
  }
  rec.geometry.carve = pack(arr);
  out_carve = {vertices: carved, deepest: +deepest.toFixed(2)};
  console.log(`terrain carve: ${carved} vertices, deepest cut ${deepest.toFixed(1)} m`);
}

// ---------- write ------------------------------------------------------------
const out = {
  meta: {
    upstreamSha: UPSTREAM_SHA, city: CITY.id, three: THREE.REVISION,
    generated: new Date().toISOString(),
    counts: {
      objects: objects.length,
      buildings: bld.instances.count,
      trees: objects.find(o=>o.kind==='trees').instances.count,
      landmarks: LMS.length,
      dynamic: dynamic.length,
    },
  },
  city: {id:CITY.id, name:CITY.name, subtitle:CITY.subtitle, tagline:CITY.tagline,
    seed:CITY.seed, start:CITY.start, bounds:CITY.bounds, theme:CITY.theme,
    tiltToGround:CITY.tiltToGround, slopeGravity:CITY.slopeGravity, safeMinY:CITY.safeMinY},
  D,
  landmarkGroups,
  objects,
  dynamic,
  binary: {bytes: byteLen},
  carve: out_carve,
};
fs.writeFileSync(path.join(ROOT,'build/city.json'), JSON.stringify(out));
fs.writeFileSync(path.join(ROOT,'build/city.bin'), Buffer.concat(chunks));
fs.unlinkSync(instrumented);

// ---------- generated terrain module (verbatim slice) ------------------------
const gen = `// GENERATED by build/city_to_json.mjs — do not edit.
// Terrain, bridge profile and switchback functions sliced verbatim from
// cities/san_francisco.js @ upstream ${UPSTREAM_SHA}. Runtime physics and the
// Blender build both consume this so ground height agrees to the last bit.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const gauss=(x,z,cx,cz,h,s)=>h*Math.exp(-((x-cx)**2+(z-cz)**2)/(2*s*s));
export const D=${D_LITERAL};
${TERRAIN_SRC.replace(/^ {4}/gm,'')}
export {coast,cityLand,terrainH,groundH,switchPath,switchHeight,BRIDGES};
`;
fs.writeFileSync(path.join(ROOT,'src/sim/sf_terrain.generated.js'), gen);


// ---------- generated runtime modules (verbatim slices) ----------------------
const GRID_SRC   = sliceLines(src, '    const GR=D.grid,XS=[],ZS=[];', '    const ROAD_W=');
const WATER_SRC  = sliceLines(src, '    const SUN_DIR=new THREE.Vector3', '    // ---- roads');
const ACTORS_SRC = sliceLines(src, '    const _up=new THREE.Vector3(),_fw=', '    // ---- minimap landmarks');
const ACTOR_UPDATE_SRC = sliceLines(src, '        for(const t of traffic){', '        for(const fn of anim)');

const genHeader = (what) => `// GENERATED by build/city_to_json.mjs — do not edit.
// ${what} sliced verbatim from cities/san_francisco.js @ upstream ${UPSTREAM_SHA}.
`;

fs.writeFileSync(path.join(ROOT,'src/render/sf_water.generated.js'), genHeader('Water shader')+
`import * as THREE from 'three';
import {D} from '../sim/sf_terrain.generated.js';
export function buildWater(scene){
${WATER_SRC.replace(/^ {4}/gm,'  ')}
  return waterMat;
}
`);

fs.writeFileSync(path.join(ROOT,'src/sim/sf_actors.generated.js'), genHeader('Traffic, police and cable-car actors')+
`import * as THREE from 'three';
import {D, coast, terrainH, groundH} from './sf_terrain.generated.js';
const lerp=(a,b,t)=>a+(b-a)*t;
const C=D.coast;
export function buildActors({scene, rand, buildCar}){
${GRID_SRC.replace(/^ {4}/gm,'  ')}
${ACTORS_SRC.replace(/^ {4}/gm,'  ')}
  const anim=[];
  let elapsed=0;
  return {
    traffic, cableCars, policeBeacons, anim, XS, ZS, GR,
    trafficPoints:()=>traffic.map(t=>({x:t.road.axis==='z'?t.road.fixed:t.s,z:t.road.axis==='z'?t.s:t.road.fixed})),
    update(dt){
      elapsed+=dt;
${ACTOR_UPDATE_SRC.replace(/^ {8}/gm,'      ')}
      for(const fn of anim)fn(elapsed,dt);
      return elapsed;
    },
  };
}
`);
console.log('generated runtime slices');

console.log(`city.json  ${(fs.statSync(path.join(ROOT,'build/city.json')).size/1e6).toFixed(2)} MB`);
console.log(`city.bin   ${(byteLen/1e6).toFixed(2)} MB`);
console.log(`objects=${objects.length} buildings=${bld.instances.count} trees=${out.meta.counts.trees} dynamic=${dynamic.length}`);
console.log(`landmark groups: ${landmarkGroups.map(g=>g.type+':'+g.objects.length).join(' ')}`);
