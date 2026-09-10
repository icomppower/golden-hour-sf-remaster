// ============================================================================
//  city_baked.js — the remastered world build
//  ---------------------------------------------------------------------------
//  Implements the upstream CITY contract, but instead of generating primitive
//  geometry at runtime it streams Blender-authored, Cycles-baked glTF chunks.
//  Everything the sim touches (ground height, bridges, traffic, landmarks)
//  still comes from the verbatim upstream slices, so physics is unchanged.
// ============================================================================
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
import {CITY as UPSTREAM} from '../../cities/san_francisco.js';
import {D, terrainH, groundH, BRIDGES} from '../sim/sf_terrain.generated.js';
import {buildWater} from './sf_water.generated.js';
import {buildActors} from '../sim/sf_actors.generated.js';
import {IrradianceGrid} from './irradiance.js';
import {LightingSets} from './lighting_sets.js';
import {ContactShadows} from './contact_shadows.js';

const CDN = 'https://unpkg.com/three@0.160.0/examples/jsm/libs/';

export let MANIFEST = null;
export async function preload(base = './dist/') {
  MANIFEST = await fetch(base + 'manifest.json').then(r => r.json());
  MANIFEST.__base = base;
  return MANIFEST;
}

// ---------------------------------------------------------------- streaming -
class ChunkStreamer {
  // Distance-based load with hysteresis: a chunk loads at `loadR` and is only
  // dropped past `dropR`, so driving along a chunk border cannot thrash.
  constructor(loader, scene, manifest, onChunk) {
    this.loader = loader; this.scene = scene; this.manifest = manifest;
    this.onChunk = onChunk;
    this.state = new Map();          // name -> {status, group}
    this.loadR = 900; this.dropR = 1250;
  }
  centre(c) {
    const b = c.bounds || this.manifest.bounds;
    return [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2];
  }
  radius(c) {
    const b = c.bounds || this.manifest.bounds;
    return Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2;
  }
  async load(c) {
    const st = this.state.get(c.name);
    if (st && st.status !== 'unloaded') return st.group;
    this.state.set(c.name, {status: 'loading', group: null});
    const gltf = await this.loader.loadAsync(this.manifest.__base + c.file);
    const g = gltf.scene;
    g.name = 'chunk_' + c.name;
    this.onChunk(g, c);
    this.scene.add(g);
    this.state.set(c.name, {status: 'loaded', group: g});
    return g;
  }
  drop(c) {
    const st = this.state.get(c.name);
    if (!st || st.status !== 'loaded') return;
    this.scene.remove(st.group);
    st.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    this.state.set(c.name, {status: 'unloaded', group: null});
  }
  update(x, z) {
    for (const c of this.manifest.chunks) {
      const [cx, cz] = this.centre(c);
      const d = Math.hypot(x - cx, z - cz) - this.radius(c);
      const st = this.state.get(c.name);
      if (d < this.loadR && (!st || st.status === 'unloaded')) this.load(c);
      else if (d > this.dropR && st && st.status === 'loaded' && !c.firstPaint) this.drop(c);
    }
  }
  get loadedCount() {
    return [...this.state.values()].filter(s => s.status === 'loaded').length;
  }
}

// ---------------------------------------------------------------- build -----
function build(api) {
  const {THREE: T, scene, renderer, rand, buildCar, lerp} = api;
  const M = MANIFEST;
  if (!M) throw new Error('city_baked: preload() must run before runCity()');

  // ---- loaders ----
  const draco = new DRACOLoader().setDecoderPath(CDN + 'draco/');
  const ktx2 = new KTX2Loader().setTranscoderPath(CDN + 'basis/');
  if (renderer) ktx2.detectSupport(renderer);
  const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);

  // ---- lighting sets (lightmaps + irradiance), lazily for night ----
  const irr = new IrradianceGrid(T);
  const sets = new LightingSets(T, M, ktx2, irr);
  sets.scene = scene; sets.renderer = renderer;
  const baked = !!M.baked;

  // Baked lighting owns the static scene, but the cars are not baked — keep the
  // sun for them alone and let the baked materials ignore it (see LightingSets).
  const dynamicSun = baked ? stripRuntimeLights(T, scene) : null;
  if (dynamicSun) sets.dynamicSun = dynamicSun;

  // ---- mesh LODs ----
  // Each chunk ships two instancing groups with identical transforms: the kit
  // meshes and their decimated twins. Swapping visibility is all the runtime
  // has to do — glTF instancing drops mesh names and every kit shares its
  // topology, so there is no key to match a single shared proxy against.
  const lodChunks = [];                      // {near:[], far:[], cx, cz, r}
  const LOD_IN = 430, LOD_OUT = 540;         // metres, hysteresis
  function registerLods(group, chunk) {
    const near = [], far = [];
    group.traverse(o => {
      if (!o.isMesh && !o.isObject3D) return;
      if (/^(bldglod|treelod)/.test(o.name || '')) far.push(o);
      else if (/^(buildings|trees)_c/.test(o.name || '')) near.push(o);
    });
    if (!near.length && !far.length) return;
    const b = chunk.bounds || M.bounds;
    for (const o of far) o.visible = false;
    lodChunks.push({near, far, cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2,
                    r: Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2, isFar: false});
  }
  function updateLods(px, pz) {
    for (const L of lodChunks) {
      const d = Math.hypot(px - L.cx, pz - L.cz) - L.r;
      if (!L.isFar && d > LOD_OUT) L.isFar = true;
      else if (L.isFar && d < LOD_IN) L.isFar = false;
      else continue;
      for (const o of L.near) o.visible = !L.isFar;
      for (const o of L.far) o.visible = L.isFar;
    }
  }

  // ---- chunk streaming ----
  const registry = [];                       // meshes awaiting lightmap binding
  const streamer = new ChunkStreamer(loader, scene, M, (group, chunk) => {
    registerLods(group, chunk);
    group.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = !baked && /bldg|landmark|bridge|tree/.test(o.name);
      o.receiveShadow = !baked;
      // A lightmap belongs to one mesh, so give every baked mesh its own
      // material instance; glTF hands out shared ones. The occlusion slot is
      // the marker that this mesh carries a baked UV channel.
      const mats0 = Array.isArray(o.material) ? o.material : [o.material];
      const hasUv2 = mats0.some(m => m && m.aoMap);
      if (baked && hasUv2) {
        o.material = Array.isArray(o.material)
          ? o.material.map(m => { const c = m.clone(); c.name = m.name; return c; })
          : (() => { const c = o.material.clone(); c.name = o.material.name; return c; })();
      }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (!mat) continue;
        // ground and masonry pick up almost nothing; glass, steel and water do
        mat.envMapIntensity = /terrain|asphalt|brick|foliage|lane|pier/i.test(mat.name || '')
          ? 0.10 : (mat.metalness > 0.35 || mat.roughness < 0.4 ? 0.7 : 0.28);
        if (baked && hasUv2) sets.prepare(o, mat);
        if (baked && o.isInstancedMesh) irr.attach(mat);
      }
      registry.push(o);
    });
    sets.bindChunk(group, chunk);
  });

  // ---- water (verbatim upstream shader) ----
  const waterMat = buildWater(scene);

  // ---- actors: traffic, police, cable cars (verbatim upstream) ----
  const actors = buildActors({scene, rand, buildCar});

  // ---- contact shadows for everything that moves ----
  const shadows = new ContactShadows(T, scene, groundH);
  const shadowSources = [];
  function updateShadows() {
    shadowSources.length = 0;
    const p = window.__game;
    if (p) shadowSources.push({x: p.x, z: p.z, r: 3.8});
    for (const t of actors.traffic) {
      const r = t.road;
      shadowSources.push(r.axis === 'z' ? {x: r.fixed, z: t.s, r: 3.6}
                                        : {x: t.s, z: r.fixed, r: 3.6});
    }
    for (const cc of actors.cableCars)
      shadowSources.push({x: cc.road.fixed, z: cc.s, r: 4.4});
    shadows.update(shadowSources);
  }

  // ---- first paint ----
  const first = M.chunks.filter(c => c.firstPaint);
  const ready = Promise.all(first.map(c => streamer.load(c)))
    .then(() => baked ? sets.activate('golden') : null)
    .then(() => { window.__world.ready = true; });

  // ---- day / night ----
  let lightingMode = 'golden', switching = false;
  async function toggleNight(showToast) {
    if (switching || !baked) return;
    const next = lightingMode === 'golden' ? 'night' : 'golden';
    switching = true;
    showToast?.(next === 'night' ? 'NIGHT · LOADING' : 'GOLDEN HOUR');
    document.body.classList.add('loading-lighting');
    try {
      await sets.load(next);                     // lazy: night is fetched on first N
      await sets.crossfade(next, 1.5);
      lightingMode = next;
      waterMat.uniforms.night.value = next === 'night' ? 1 : 0;
      showToast?.(next === 'night' ? 'NIGHT' : 'GOLDEN HOUR');
    } finally {
      document.body.classList.remove('loading-lighting');
      switching = false;
    }
  }
  CITY.onKey = (k, ctx) => { if (k === 'n') toggleNight(ctx.showToast); };

  // ---- world contract ----
  let voidHits = 0;
  const world = {
    collide: () => null,
    groundH,
    onVoid: (x, z) => {
      const v = groundH(x, z) < 0.2;
      if (v) voidHits++;
      return v;
    },
    landmarks: M.landmarks,
    minimapBlocks: M.minimapBlocks,
    trafficPoints: actors.trafficPoints,
    size: 1500,
    districts: UPSTREAM.districts,
    update(dt) {
      const t = actors.update(dt);
      waterMat.uniforms.time.value = t;
      updateShadows();
      sets.update(dt);
      const p = window.__game;
      if (p) { streamer.update(p.x, p.z); updateLods(p.x, p.z); }
    },
  };

  window.__world = {
    ready: false, streamer, sets, irr, actors, loader, scene, shadows,
    get voidHits() { return voidHits; },
    get chunksLoaded() { return streamer.loadedCount; },
    get lighting() { return lightingMode; },
    get lods() { return lodChunks.map(l => ({near: l.near.length, far: l.far.length, isFar: l.isFar})); },
    toggleNight, groundH, terrainH, manifest: M, readyPromise: ready,
  };
  return world;
}

// Baked lighting owns the static scene, so the engine's hemi/ambient/fill lights
// and its shadow maps would double-light everything. One directional light is
// kept as the dynamic-object sun; baked materials zero out its direct term.
// Stripped here rather than upstream so engine.js stays verbatim.
function stripRuntimeLights(T, scene) {
  const kill = [];
  let sun = null;
  scene.traverse(o => {
    if (o.isDirectionalLight) {
      if (!sun && o.intensity > 0.6) { sun = o; return; }   // the theme sun, not the fill
      kill.push(o);
    } else if (o.isHemisphereLight || o.isAmbientLight) kill.push(o);
  });
  for (const l of kill) l.parent?.remove(l);
  if (sun) {
    sun.castShadow = false;        // contact shadows replace the shadow map
    sun.name = 'dynamic_sun';
  }
  return sun;
}

export const CITY = {...UPSTREAM, build};
