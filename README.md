# Golden Hour SF — Remaster

Graphics-only remaster of `icomppower/sf-sunset-drive`. Blender authors and
bakes the city offline; three.js still renders it in the browser. Physics,
traffic, cameras, audio and city layout are untouched — `src/sim/engine.js` is a
byte-identical copy of upstream and the sim-facing modules are generated
verbatim slices of `cities/san_francisco.js`.

Spec, status and the divergence log live in Notion:
**Golden Hour SF Remaster — Blender-Baked Graphics Spec**.

## Build

```sh
npm install
npm run build      # extract -> landmark assets -> golden bake -> night bake -> pack
npm run gates      # traversal, perf, visual captures
npm run serve      # http://localhost:8099
```

`npm run pack` is the payload gate: it exits non-zero if any budget in spec
section 6 is exceeded. Requires Blender (pinned in `build/BLENDER_VERSION`).

## Controls

W/A/S/D or arrows drive, SPACE drifts, C cycles camera, R resets, T tours the
landmarks, **N** swaps golden hour for night (lazy-loaded, 1.5 s crossfade).

Test harness: `?auto=1` self-drives the traversal gate, `?cam=<id>` parks at one
of the eight canonical viewpoints, `?start=1` skips the title overlay.
