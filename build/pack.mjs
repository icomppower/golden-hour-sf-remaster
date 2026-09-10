// ============================================================================
//  pack.mjs — Draco + KTX2 compression, chunk manifest, payload budget gate
//  ---------------------------------------------------------------------------
//  Reads build/gltf/*.glb, compresses geometry (Draco) and every texture
//  (KTX2 / Basis ETC1S — no PNG or JPEG survives), injects the baked UV2
//  channel from the sidecars build_city.py writes, and emits dist/.
//
//  Exits non-zero if any section-6 budget is exceeded. This IS the payload gate.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NodeIO, Logger} from '@gltf-transform/core';
import {KHRDracoMeshCompression, KHRTextureBasisu, EXTMeshGPUInstancing} from '@gltf-transform/extensions';
import {draco, dedup, prune, resample, weld} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import {NodeBasisEncoder} from 'ktx2-encoder';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has  = f => argv.includes(f);
const FAST = has('--fast');                       // skip texture compression
const MB = 1e6;

const BUDGET = {                                   // section 6 — hard gate
  firstPaint: 12*MB, goldenTotal: 28*MB, nightSet: 12*MB,
  chunk: 4*MB, irradiance: 300e3,
};

const log = (...a) => console.log('[pack]', ...a);
const enc = new NodeBasisEncoder();
const decodePNG = async (b) => {
  const {data, info} = await sharp(Buffer.from(b)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  return {width:info.width, height:info.height, data};
};

async function toKTX2(bytes, {srgb}) {
  return new Uint8Array(await enc.encode(new Uint8Array(bytes), {
    imageDecoder: decodePNG, isUASTC: false, isKTX2: true,
    qualityLevel: srgb ? 190 : 210, compressionLevel: 3,
    generateMipmap: true, perceptual: !!srgb, mipSRGB: !!srgb,
  }));
}

const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression, KHRTextureBasisu, EXTMeshGPUInstancing])
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
io.setLogger(new Logger(Logger.Verbosity.ERROR));

// ---------------------------------------------------------------- uv2 -------
function injectUV2(doc, sidecar) {
  if (!sidecar) return 0;
  let n = 0;
  const root = doc.getRoot();
  for (const mesh of root.listMeshes()) {
    const entry = sidecar[mesh.getName()];
    if (!entry) continue;
    const uv = Float32Array.from(entry.uv);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos || pos.getCount()*2 !== uv.length) continue;
      const acc = doc.createAccessor(mesh.getName()+'_uv2')
        .setArray(uv).setType('VEC2').setBuffer(root.listBuffers()[0]);
      prim.setAttribute('TEXCOORD_1', acc);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- pack ------
async function packOne(src, dstDir, sidecars) {
  const doc = await io.read(src);
  const name = path.basename(src);
  const sidecar = sidecars[name.replace(/\.glb$/, '.uv2.json')];
  const uv2 = injectUV2(doc, sidecar);

  // keepAttributes/keepSolidTextures: the 4x4 white occlusion carrier is the
  // only thing holding TEXCOORD_1 in the file. Pruning it as a "solid texture"
  // takes the baked UV2 channel with it and the lightmaps have nowhere to land.
  await doc.transform(dedup(), prune({keepAttributes: true, keepSolidTextures: true}),
                      resample(), weld());

  if (!FAST) {
    const basisu = doc.createExtension(KHRTextureBasisu).setRequired(true);
    for (const tex of doc.getRoot().listTextures()) {
      const img = tex.getImage();
      if (!img || tex.getMimeType() === 'image/ktx2') continue;
      const srgb = !/(_n|_normal|_rough|_data|_lm)/i.test(tex.getName() || '');
      const before = img.byteLength;
      const ktx = await toKTX2(img, {srgb});
      tex.setImage(ktx).setMimeType('image/ktx2');
      log(`  tex ${tex.getName()||'?'} ${(before/1e3).toFixed(0)}kB -> ${(ktx.byteLength/1e3).toFixed(0)}kB ktx2`);
    }
    void basisu;
  }

  await doc.transform(draco({method:'edgebreaker', quantizePosition:14,
    quantizeNormal:10, quantizeTexcoord:12, quantizeColor:8, quantizeGeneric:12}));

  const out = path.join(dstDir, name);
  fs.mkdirSync(dstDir, {recursive:true});
  const glb = await io.writeBinary(doc);
  fs.writeFileSync(out, glb);
  return {file: path.relative(path.join(ROOT,'dist'), out), bytes: glb.byteLength, uv2};
}

async function main() {
  const gltfDir = path.join(ROOT, 'build/gltf');
  const distDir = path.join(ROOT, 'dist');
  const files = fs.readdirSync(gltfDir).filter(f => f.endsWith('.glb')).sort();
  if (!files.length) throw new Error('no GLB input in build/gltf');

  const sidecars = {};
  for (const f of fs.readdirSync(gltfDir).filter(f => f.endsWith('.uv2.json')))
    sidecars[f] = JSON.parse(fs.readFileSync(path.join(gltfDir, f), 'utf8'));

  const world = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/world.json'), 'utf8'));
  const chunks = [];
  for (const f of files) {
    const r = await packOne(path.join(gltfDir, f), path.join(distDir, 'chunks'), sidecars);
    const meta = world.chunks?.find(c => c.file === f) || {};
    chunks.push({...meta, ...r, name: f.replace(/\.glb$/, '')});
    log(`${f} -> ${(r.bytes/MB).toFixed(2)} MB${r.uv2 ? ` (uv2 on ${r.uv2} prims)` : ''}`);
  }

  // lighting payloads: every lightmap PNG becomes KTX2/ETC1S, the irradiance
  // volume and set.json travel as-is. No PNG or JPEG reaches dist/.
  const lighting = {};
  const lightDir = path.join(ROOT, 'build/lighting');
  if (fs.existsSync(lightDir)) {
    for (const set of fs.readdirSync(lightDir)) {
      const srcDir = path.join(lightDir, set);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(distDir, 'lighting', set);
      fs.mkdirSync(dstDir, {recursive:true});
      let bytes = 0; const files = [];
      for (const f of fs.readdirSync(srcDir)) {
        const src = path.join(srcDir, f);
        let name = f, payload;
        if (f.endsWith('.png') && !FAST) {
          name = f.replace(/\.png$/, '.ktx2');
          payload = Buffer.from(await toKTX2(fs.readFileSync(src), {srgb:true}));
          log(`  ${f} ${(fs.statSync(src).size/1e3).toFixed(0)}kB -> ${(payload.length/1e3).toFixed(0)}kB ktx2`);
        } else if (f.endsWith('.png')) {
          continue;                                    // --fast: skip lightmaps
        } else {
          payload = fs.readFileSync(src);
        }
        fs.writeFileSync(path.join(dstDir, name), payload);
        bytes += payload.length;
        files.push({file:`lighting/${set}/${name}`, bytes:payload.length});
      }
      const setMeta = JSON.parse(fs.readFileSync(path.join(srcDir, 'set.json'), 'utf8'));
      lighting[set] = {bytes, files, lightmaps: setMeta.lightmaps?.length ?? 0,
        irradiance: setMeta.irradiance ?? null};
      log(`lighting/${set}: ${(bytes/MB).toFixed(2)} MB over ${files.length} files`);
    }
  }

  const manifest = {
    generated: new Date().toISOString(),
    upstreamSha: world.upstreamSha,
    baked: !!Object.keys(lighting).length,
    bounds: world.bounds, chunkGrid: world.chunkGrid ?? null,
    chunks, lighting,
    landmarks: world.landmarks, minimapBlocks: world.minimapBlocks,
    cameras: world.cameras,
    budget: BUDGET,
  };
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(manifest));

  // ------------------------------------------------------------ budgets -----
  const fails = [];
  const chunkTotal = chunks.reduce((a, c) => a + c.bytes, 0);
  const goldenBytes = (lighting.golden?.bytes ?? 0);
  const nightBytes  = (lighting.night?.bytes ?? 0);
  // First paint = the resident chunks plus the golden payloads they need:
  // the hero atlas, the irradiance volume, the environment, and set.json.
  const firstNames = new Set(chunks.filter(c => c.firstPaint)
    .map(c => (c.name.match(/^chunk_(c\d\d|core)/) || [])[1]).filter(Boolean));
  const firstLight = (lighting.golden?.files ?? []).filter(f =>
    /lm_hero\d*|irradiance|env\.|set\.json/.test(f.file) ||
    [...firstNames].some(n => n !== 'core' && f.file.includes(`terrain_${n.slice(1)}`)));
  const firstPaint = chunks.filter(c => c.firstPaint).reduce((a,c)=>a+c.bytes, 0)
                   + firstLight.reduce((a,f)=>a+f.bytes, 0);
  const check = (label, got, cap) => {
    const ok = got <= cap;
    log(`${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(26)} ${(got/MB).toFixed(2)} MB / ${(cap/MB).toFixed(2)} MB`);
    if (!ok) fails.push(`${label}: ${(got/MB).toFixed(2)} MB > ${(cap/MB).toFixed(2)} MB`);
  };
  check('first paint', firstPaint || chunks[0]?.bytes || 0, BUDGET.firstPaint);
  check('golden total', chunkTotal + goldenBytes, BUDGET.goldenTotal);
  check('night lighting set', nightBytes, BUDGET.nightSet);
  for (const c of chunks) check(`chunk ${c.name}`, c.bytes, BUDGET.chunk);
  for (const [set, l] of Object.entries(lighting)) {
    const irr = (l.files || []).filter(f => /irradiance/.test(f.file)).reduce((a,f)=>a+f.bytes, 0);
    if (irr) check(`irradiance ${set}`, irr, BUDGET.irradiance);
  }
  if (fails.length) {
    console.error('\n[pack] PAYLOAD BUDGET EXCEEDED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  log('all budgets OK');
}
await main();
