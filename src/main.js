// ============================================================================
//  main.js — boot, test harness hooks, autopilot, canonical camera viewpoints
// ============================================================================
import * as THREE from 'three';
import {runCity} from './sim/engine.js';
import {CITY, preload} from './render/city_baked.js';
import {groundH, switchPath, D} from './sim/sf_terrain.generated.js';

const q = new URLSearchParams(location.search);
const manifest = await preload('./dist/');
const ctx = runCity(CITY);
window.__ctx = ctx;

// ---------------------------------------------------------------- telemetry -
// Frame times sampled on the same rAF cadence the engine renders on. The perf
// gate reads p95 from here in real Chrome; swiftshader numbers are not a signal.
const tele = window.__perf = {frames: [], p: (q95) => {
  const a = [...tele.frames].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q95))] : 0;
}, reset: () => { tele.frames.length = 0; }};
let prev = performance.now();
(function sample(now) {
  requestAnimationFrame(sample);
  const dt = now - prev; prev = now;
  if (dt > 0 && dt < 500) { tele.frames.push(dt); if (tele.frames.length > 4000) tele.frames.shift(); }
})(prev);

// ---------------------------------------------------------------- probes ----
// Numeric assertions for the gates: geometry alignment is checked by raycasting
// the loaded GLB terrain against the sim's groundH, never by eyeballing a shot.
const ray = new THREE.Raycaster();
window.__probe = {
  manifest,
  groundH,
  terrainDelta(x, z) {
    // Cast from just above the sim's ground so overhead structure (bridge
    // bracing, cables) cannot masquerade as a misaligned surface.
    const g = groundH(x, z);
    ray.set(new THREE.Vector3(x, g + 2.5, z), new THREE.Vector3(0, -1, 0));
    ray.far = 9;
    // Match the object's OWN name: every mesh in a chunk has a parent called
    // chunk_*, so testing the parent made this probe measure whichever tree or
    // building happened to overhang the sample point.
    const targets = [];
    ctx.scene.traverse(o => {
      if (o.isMesh && /^(terrain|roads|road_dashes|lombard_street|bridge_)/.test(o.name || '')) targets.push(o);
    });
    const hits = ray.intersectObjects(targets, true);
    if (!hits.length) return null;
    return hits[0].point.y - groundH(x, z);
  },
  state: () => ({...ctx.state}),
  switchPath,
  switchback: D.switchback,
  drawCalls: () => ctx.renderer.info.render.calls,
  triangles: () => ctx.renderer.info.render.triangles,
};

// ---------------------------------------------------------------- cameras ---
// ?cam=<id> parks the chase camera at one of the eight canonical viewpoints.
const camId = q.get('cam');
if (camId) {
  const c = (manifest.cameras || []).find(v => v.id === camId);
  if (c) {
    // framed viewpoints carry absolute heights; hand-placed ones ride the ground
    const pos = new THREE.Vector3(c.x, c.y ?? (groundH(c.x, c.z) + c.yOff), c.z);
    const look = new THREE.Vector3(c.lx, c.ly ?? (groundH(c.lx, c.lz) + c.lyOff), c.lz);
    // The engine writes the chase camera every frame and renders inside its own
    // rAF, so a later rAF cannot win. Freeze the matrix instead: with
    // matrixAutoUpdate off the renderer reads matrixWorld and ignores position.
    const cam = ctx.camera;
    cam.matrixAutoUpdate = false;
    const hold = () => {
      requestAnimationFrame(hold);
      cam.position.copy(pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(look);
      cam.updateMatrix();
      cam.matrixWorld.copy(cam.matrix);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    };
    hold();
    document.getElementById('title')?.remove();
    document.getElementById('hud')?.remove();
    document.getElementById('hint')?.remove();
    document.getElementById('mini')?.remove();
    window.__probe.viewpoint = c;
  }
}

// ---------------------------------------------------------------- autopilot -
// ?auto=1 drives the traversal gate: start -> north across the Golden Gate ->
// Marin headlands. It steers by synthesising key events, so engine.js input,
// physics and respawn logic all run exactly as they do for a human driver.
function key(k, down) {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {key: k, bubbles: true}));
}
function autopilot() {
  const st = ctx.state;
  const route = [
    {x: -300, z: 40}, {x: -300, z: -200}, {x: -300, z: -400},
    {x: -300, z: -620}, {x: -300, z: -700}, {x: -300, z: -760},
  ];
  let leg = 0;
  const held = {};
  const set = (k, want) => { if (!!held[k] !== !!want) { held[k] = want; key(k, want); } };
  const auto = window.__auto = {done: false, leg: 0, maxSpeed: 0, samples: []};
  const tick = () => {
    if (auto.done) return;
    requestAnimationFrame(tick);
    const tgt = route[Math.min(leg, route.length - 1)];
    const dz = tgt.z - st.z, dx = tgt.x - st.x;
    if (Math.hypot(dx, dz) < 26 && leg < route.length - 1) { leg++; auto.leg = leg; }
    // desired heading: engine forward is (sin h, cos h)
    const want = Math.atan2(dx, dz);
    let err = want - st.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const spd = Math.abs(st.vf);
    set('a', err < -0.035);
    set('d', err > 0.035);
    set('w', spd < (Math.abs(err) > 0.5 ? 16 : 30));
    set('s', spd > 34);
    auto.maxSpeed = Math.max(auto.maxSpeed, spd);
    auto.samples.push({t: window.__game.t, x: st.x, z: st.z, y: st.y});
    if (st.z < -742) { auto.done = true; auto.reached = true; ['w','a','s','d'].forEach(k => set(k, false)); }
  };
  ctx.start();
  requestAnimationFrame(tick);
}
if (q.get('auto') === '1') {
  window.__world.readyPromise.then(autopilot);
}
if (q.get('start') === '1') ctx.start();

// ?night=1 — used by the visual gate to capture both lighting conditions.
if (q.get('night') === '1') {
  window.__world.readyPromise
    .then(() => window.__world.toggleNight(ctx.showToast))
    .then(() => { window.__world.nightReady = true; });
}
