// ============================================================================
//  lighting_sets.js — baked lightmap sets, lazy night load, 1.5 s crossfade
//  ---------------------------------------------------------------------------
//  Geometry is shared between golden hour and night; only the lighting payload
//  differs. Both sets use the same UV2 layout and atlas packing, so switching
//  is a texture rebind plus a mix uniform — never a geometry reload.
// ============================================================================
// Measured, not assumed: Cycles' colourless Diffuse Direct+Indirect bake comes
// back already in three's `irradiance` units, so no pi conversion belongs here.
// Baking one in blew the terrain to pure white — see docs/DIVERGENCE.md.
// `__world.sets.exposure` is the tuning handle on top of it.
export const LIGHTMAP_GAIN = 1.0;

export class LightingSets {
  constructor(THREE, manifest, ktx2Loader, irradiance) {
    this.THREE = THREE;
    this.manifest = manifest;
    this.ktx2 = ktx2Loader;
    this.irr = irradiance;
    this.sets = {};                 // name -> {meta, textures:Map, env}
    this.materials = new Map();     // material -> {name}
    this.meshNames = new Map();     // material -> mesh name
    this.active = null;
    this.uniforms = {lightMapB: {value: null}, lmMix: {value: 0}};
    this.tween = null;
    this.scene = null;
    this.pmrem = null;
    this.exposure = 1.0;          // visual-iteration handle, see __world.sets
  }

  /** Patch a material so it can hold two lightmaps and mix between them.
   *  Callers must hand in a material unique to this mesh: lightmap bindings are
   *  per-mesh, and a shared glTF material would leak one mesh's atlas onto
   *  another (and onto meshes with no UV2 at all, which fails to compile). */
  prepare(mesh, mat) {
    if (!mat.userData.__lm) {
      mat.userData.__lm = true;
      const U = this.uniforms;
      const prev = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader, renderer) => {
        prev?.(shader, renderer);
        Object.assign(shader.uniforms, U);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D lightMapB;\nuniform float lmMix;')
          // the surviving directional light exists for the cars; a baked
          // surface already contains its direct contribution
          .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  reflectedLight.directDiffuse = vec3( 0.0 );
  reflectedLight.directSpecular = vec3( 0.0 );`)
          .replace('vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;',
                   'vec3 lightMapIrradiance = mix( lightMapTexel.rgb, texture2D( lightMapB, vLightMapUv ).rgb, lmMix ) * lightMapIntensity;');
      };
      mat.needsUpdate = true;
    }
    // The glTF occlusion slot exists only to carry the baked UV channel through
    // export. Which channel that is depends on how many UV sets the material
    // actually used, so read it off the loaded texture instead of assuming 1.
    const channel = mat.aoMap ? (mat.aoMap.channel ?? 1) : 1;
    mat.aoMap = null;
    this.materials.set(mat, {
      mesh: mesh.name || '',
      base: (mesh.name || '').replace(/_\d+$/, ''),      // glTF multi-primitive suffix
      parent: mesh.parent?.name || '',
      geom: mesh.geometry.name || '',
      mat: mat.name || '',
      channel,
    });
    return mat;
  }

  async load(name) {
    if (this.sets[name]) return this.sets[name];
    const base = this.manifest.__base;
    const meta = await fetch(`${base}lighting/${name}/set.json`).then(r => r.json());
    const textures = new Map();
    await Promise.all((meta.lightmaps || []).map(async (lm) => {
      const tex = await this.ktx2.loadAsync(`${base}lighting/${name}/${lm.file}`);
      tex.flipY = false;
      tex.channel = 1;                     // 0.160: lightMap reads material.lightMap.channel
      tex.colorSpace = this.THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      textures.set(lm.id, tex);
    }));
    let env = null;
    if (meta.env) {
      const eq = await this.ktx2.loadAsync(`${base}lighting/${name}/${meta.env}`);
      eq.mapping = this.THREE.EquirectangularReflectionMapping;
      eq.colorSpace = this.THREE.SRGBColorSpace;
      env = eq;
    }
    let irr = null;
    if (meta.irradiance) {
      const buf = await fetch(`${base}lighting/${name}/${meta.irradiance.file}`).then(r => r.arrayBuffer());
      irr = {...meta.irradiance, data: new Uint8Array(buf)};
    }
    this.sets[name] = {meta, textures, env, irr};
    return this.sets[name];
  }

  /** Chunks stream in after the set is already active, so re-apply the active
   *  set to whatever materials the new chunk just registered. */
  bindChunk() {
    if (this.active) this.apply(this.active, 'A');
    if (this.tween) this.apply(this.tween.to, 'B');
  }

  /** Assign a loaded set into slot A (immediate) or slot B (for a crossfade). */
  apply(name, slot) {
    const set = this.sets[name];
    if (!set) return;
    for (const [mat, keys] of this.materials) {
      const b = set.meta.bindings[keys.mesh] || set.meta.bindings[keys.base]
             || set.meta.bindings[keys.parent] || set.meta.bindings[keys.geom]
             || set.meta.bindings[keys.mat] || set.meta.bindings['*'];
      const tex = b && set.textures.get(b.id);
      if (tex && b.slot === 'aoMap') {
        // Tier B: position-independent AO in the kit's own texture space
        if (slot === 'A') {
          mat.aoMap = tex;
          mat.aoMap.channel = keys.channel;
          mat.aoMapIntensity = 1;
          mat.needsUpdate = true;
        }
      } else if (tex) {
        if (slot === 'A') {
          mat.lightMap = tex;
          mat.lightMap.channel = keys.channel;
          mat.lightMapIntensity = (b.intensity ?? 1) * LIGHTMAP_GAIN * this.exposure;
          mat.needsUpdate = true;
        } else {
          this.uniforms.lightMapB.value = tex;
        }
      }
      const em = set.meta.emissive?.[mat.name];
      if (em != null) {
        if (slot === 'A') mat.emissiveIntensity = em;
        else mat.userData.__emTarget = em;
      }
    }
    if (set.irr) {
      this.irr.setGrid(slot === 'A' ? 'A' : 'B', {
        data: set.irr.data, dims: set.irr.dims, bounds: set.irr.bounds,
        scale: set.irr.scale * LIGHTMAP_GAIN * this.exposure,
        sun: set.irr.sun,
        sunColor: set.irr.sunColor, skyColor: set.irr.skyColor,
      });
    }
  }

  async activate(name) {
    await this.load(name);
    this.apply(name, 'A');
    this.uniforms.lmMix.value = 0;
    this.irr.setMix(0);
    this.applyAtmosphere(name, 1);
    this.active = name;
  }

  /** Sky, fog and exposure belong to the lighting set too; t blends A -> B. */
  applyAtmosphere(name, t) {
    const set = this.sets[name];
    if (!set || !this.scene) return;
    const T = this.THREE, a = set.meta.atmosphere;
    if (!a) return;
    const {scene, renderer} = this;
    if (scene.fog) {
      scene.fog.color.lerp(new T.Color(a.fogColor), t);
      scene.fog.density = T.MathUtils.lerp(scene.fog.density, a.fogDensity, t);
    }
    if (scene.background?.isColor) scene.background.lerp(new T.Color(a.skyColor), t);
    if (set.env && t > 0.5) scene.environment = this.prefilter(set.env);
    if (renderer) renderer.toneMappingExposure =
      T.MathUtils.lerp(renderer.toneMappingExposure, a.exposure, t);
    if (this.dynamicSun && a.sun) {
      const s = this.dynamicSun;
      s.color.lerp(new T.Color(a.sun.color), t);
      s.intensity = T.MathUtils.lerp(s.intensity, a.sun.intensity, t);
      s.position.set(a.sun.dir[0], a.sun.dir[1], a.sun.dir[2]).multiplyScalar(300);
      s.target.position.set(0, 0, 0);
      s.target.updateMatrixWorld();
    }
  }

  prefilter(equirect) {
    if (equirect.userData.__pmrem) return equirect.userData.__pmrem;
    if (!this.renderer) return null;
    this.pmrem ||= new this.THREE.PMREMGenerator(this.renderer);
    const rt = this.pmrem.fromEquirectangular(equirect);
    equirect.userData.__pmrem = rt.texture;
    return rt.texture;
  }

  async crossfade(name, seconds = 1.5) {
    await this.load(name);
    this.apply(name, 'B');
    return new Promise((resolve) => {
      this.tween = {t: 0, dur: seconds, to: name, resolve};
    });
  }

  update(dt) {
    const tw = this.tween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    const e = tw.t * tw.t * (3 - 2 * tw.t);
    this.uniforms.lmMix.value = e;
    this.irr.setMix(e);
    this.applyAtmosphere(tw.to, Math.min(1, dt / tw.dur * 3));
    for (const [mat] of this.materials) {
      const target = mat.userData.__emTarget;
      if (target != null) mat.emissiveIntensity += (target - mat.emissiveIntensity) * Math.min(1, dt / tw.dur * 3);
    }
    if (tw.t >= 1) {
      this.apply(tw.to, 'A');          // promote B to A, reset the mix
      this.uniforms.lmMix.value = 0;
      this.irr.setGrid('A', {...this.sets[tw.to].irr, data: this.sets[tw.to].irr.data});
      this.irr.setMix(0);
      this.active = tw.to;
      const done = tw.resolve;
      this.tween = null;
      done?.();
    }
  }
}
