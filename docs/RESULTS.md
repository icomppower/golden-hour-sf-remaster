# Kill gate — results

Run `npm run build && npm run gates`. Numbers below are from the shipped build.

## 1. Traversal — PASS
`?auto=1` self-drives from the start north across the full Golden Gate span into
the Marin headlands, headless under swiftshader.

| check | result |
|---|---|
| reaches Marin (z < −742) | z = −743 at t = 31.1 s of 60 s |
| water respawns (`onVoid` hits) | 0 |
| sub-terrain penetration | min (carY − groundH) = 0.000 m |
| baked geometry vs sim ground | worst 0.156 m over 45 probes (the 0.13 m road lift) |
| Lombard cut | 26 of 28 probes within 0.2 m; worst 2.50 m at a hairpin |
| runtime errors | none |

## 2. Payload — PASS (this is `npm run build` itself)

| item | budget | actual |
|---|---|---|
| first paint | ≤ 12 MB | 2.6 MB |
| golden-hour total | ≤ 28 MB | 3.6 MB |
| night lighting set | ≤ 12 MB | 3.0 MB |
| largest single chunk | ≤ 4 MB | 0.3 MB |
| irradiance grid per set | ≤ 300 KB | 197 KB |

All geometry Draco-compressed, every texture KTX2/ETC1S. No PNG or JPEG in `dist/`.

## 3. Performance — PASS
Measured on-device in real Chrome (ANGLE Metal on an Apple M4) at 1080p, chase
camera, driving the downtown grid. Never under swiftshader.

| metric | budget | actual |
|---|---|---|
| p95 frame time | ≤ 16.7 ms | **6.30 ms** |
| p50 frame time | — | 4.20 ms |
| sample | — | 4000 frames |

**vsync must be off for this measurement.** With it on, rAF deltas are clamped
to the display's 16.7 ms refresh period: the first run read p50 = 16.70 ms and
p95 = 18.20 ms, which is the monitor, not the frame cost.

## 4. Visual — NOT MET
Eight canonical viewpoints in both lighting conditions, scored on contact-shadow
presence, material differentiation, silhouette readability and lighting
coherence (`test/rubric.mjs` measures each off the framebuffer).

Mean **6.71** against a bar of 7.5, with `castro_golden` at 4.43 below the
per-viewpoint floor of 6. The loop stopped at iteration 6 of its 6-iteration
budget — the section-9 hard cap, set before the loop started. It had already
tripped the plateau exit twice. State is in `build/loop_state.json`.

**The rubric numbers are proxies and two of them are currently lying.** The
`lombard` frame scores 6.89 while the camera is standing inside a building with
the horizon rolled 90°: edge density and colour entropy both read "busy". Trust
the images over the score for that viewpoint and `castro`.

Known work, in order of expected payoff:
1. **Re-aim `lombard` and `castro`.** The framing helper places a camera from
   the landmark's bounding box and the terrain under it, but nothing stops it
   landing inside a building. It needs an occlusion check — march the camera
   back along the view ray until the landmark is actually visible.
2. **Rebuild the road ribbon.** Upstream's is a constant-width strip that folds
   at the switchback's hairpins (this is the residual 2.5 m in gate 1, and the
   reason Lombard's surface looks torn up close). A mitred offset is a graphics
   change and in scope.
3. **Terrain albedo.** The bake is physically sound but the ground still uses
   upstream's vertex colours with no detail texture, so it reads pale under a
   bright golden-hour sky. Spec §1 asks for real PBR materials; terrain is the
   one surface family that did not get them.
4. Trees are a single low-poly conifer with no variation.
