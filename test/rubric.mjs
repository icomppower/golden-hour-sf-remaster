// ============================================================================
//  rubric.mjs — numeric proxies for the section-8 visual rubric
//  ---------------------------------------------------------------------------
//  Screenshots alone prove very little, so each rubric axis gets a measurement
//  taken straight off the framebuffer. These scores are the falsifiable half of
//  gate 4; the images are still looked at, but a regression shows up here first.
//
//    node test/rubric.mjs [shotsDir]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DIR = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), 'shots');

const lum = (r, g, b) => 0.2126*r + 0.7152*g + 0.0722*b;
function hue(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-6) return 0;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const clamp01 = v => Math.max(0, Math.min(1, v));
const score = (v, lo, hi) => 1 + 9 * clamp01((v - lo) / (hi - lo));

export async function measure(file) {
  const {data, info} = await sharp(file).resize(640, 360, {fit: 'fill'})
    .removeAlpha().raw().toBuffer({resolveWithObject: true});
  const W = info.width, H = info.height;
  const L = new Float32Array(W*H);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) L[p] = lum(data[i], data[i+1], data[i+2]) / 255;

  // --- sky band: the brightest, least textured rows at the top -------------
  const skyRows = Math.floor(H * 0.22);
  let skyR = 0, skyG = 0, skyB = 0, skyN = 0;
  for (let y = 0; y < skyRows; y++) for (let x = 0; x < W; x++) {
    const i = (y*W + x)*3;
    skyR += data[i]; skyG += data[i+1]; skyB += data[i+2]; skyN++;
  }
  skyR /= skyN; skyG /= skyN; skyB /= skyN;

  // --- 1. contact shadow presence -----------------------------------------
  // Dark pockets relative to a 24 px neighbourhood, restricted to the ground
  // half of the frame. Flat unlit geometry scores near zero.
  let pocket = 0, groundN = 0;
  const R = 12;
  for (let y = Math.floor(H*0.45); y < H; y += 2) {
    for (let x = R; x < W - R; x += 2) {
      let sum = 0, n = 0;
      for (let dx = -R; dx <= R; dx += 4) { sum += L[y*W + x + dx]; n++; }
      const local = sum / n;
      if (L[y*W + x] < local - 0.09) pocket++;
      groundN++;
    }
  }
  const contactShadow = pocket / Math.max(groundN, 1);

  // --- 2. material differentiation ----------------------------------------
  // Joint hue x luminance histogram entropy over non-sky pixels.
  const HB = 12, LB = 8, hist = new Float64Array(HB*LB);
  let n2 = 0;
  for (let y = Math.floor(H*0.25); y < H; y++) for (let x = 0; x < W; x += 2) {
    const i = (y*W + x)*3;
    const h = Math.floor(hue(data[i], data[i+1], data[i+2]) / 360 * HB) % HB;
    const l = Math.min(LB-1, Math.floor(L[y*W + x] * LB));
    hist[h*LB + l]++; n2++;
  }
  let ent = 0;
  for (const c of hist) if (c > 0) { const p = c / n2; ent -= p * Math.log2(p); }
  const materialEntropy = ent / Math.log2(HB*LB);       // 0..1

  // --- 3. landmark silhouette readability ---------------------------------
  // Sobel edge energy in the skyline band, i.e. contrast against the sky.
  let edge = 0, edgeN = 0;
  for (let y = 1; y < Math.floor(H*0.7); y++) for (let x = 1; x < W-1; x++) {
    const gx = L[y*W + x + 1] - L[y*W + x - 1];
    const gy = L[(y+1)*W + x] - L[(y-1)*W + x];
    edge += Math.hypot(gx, gy); edgeN++;
  }
  const silhouette = edge / Math.max(edgeN, 1);

  // --- 4. lighting coherence with the sky ---------------------------------
  // Hue distance between the sky and the brightest lit surfaces: a baked scene
  // lit by that sky should share its warmth.
  let litR = 0, litG = 0, litB = 0, litN = 0;
  for (let y = Math.floor(H*0.3); y < H; y++) for (let x = 0; x < W; x++) {
    const p = y*W + x;
    if (L[p] < 0.42) continue;
    const i = p*3;
    litR += data[i]; litG += data[i+1]; litB += data[i+2]; litN++;
  }
  let coherence = 0;
  if (litN > 200) {
    litR /= litN; litG /= litN; litB /= litN;
    let dh = Math.abs(hue(skyR, skyG, skyB) - hue(litR, litG, litB));
    if (dh > 180) dh = 360 - dh;
    coherence = 1 - dh / 180;
  }

  const scores = {
    contactShadow: score(contactShadow, 0.01, 0.14),
    materialDifferentiation: score(materialEntropy, 0.30, 0.66),
    silhouette: score(silhouette, 0.012, 0.075),
    lightingCoherence: score(coherence, 0.45, 0.95),
  };
  const mean = Object.values(scores).reduce((a, b) => a + b, 0) / 4;
  return {file: path.basename(file), raw: {contactShadow, materialEntropy, silhouette, coherence},
          scores, mean};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.png')).sort();
  const rows = [];
  for (const f of files) rows.push(await measure(path.join(DIR, f)));
  const w = Math.max(...rows.map(r => r.file.length));
  console.log('viewpoint'.padEnd(w) + '  shadow  material  silhouette  coherence   MEAN');
  for (const r of rows) {
    console.log(r.file.padEnd(w) +
      `  ${r.scores.contactShadow.toFixed(1).padStart(6)}` +
      `  ${r.scores.materialDifferentiation.toFixed(1).padStart(8)}` +
      `  ${r.scores.silhouette.toFixed(1).padStart(10)}` +
      `  ${r.scores.lightingCoherence.toFixed(1).padStart(9)}` +
      `  ${r.mean.toFixed(2).padStart(5)}`);
  }
  const means = rows.map(r => r.mean);
  const overall = means.reduce((a, b) => a + b, 0) / means.length;
  const worst = Math.min(...means);
  fs.writeFileSync(path.join(DIR, 'rubric.json'), JSON.stringify({rows, overall, worst}, null, 1));
  console.log(`\nmean ${overall.toFixed(2)} (pass >= 7.5)   worst ${worst.toFixed(2)} (pass >= 6.0)`);
  process.exit(overall >= 7.5 && worst >= 6.0 ? 0 : 1);
}
