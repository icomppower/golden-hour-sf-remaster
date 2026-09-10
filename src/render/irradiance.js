// ============================================================================
//  irradiance.js — coarse baked irradiance volume for the instanced filler
//  ---------------------------------------------------------------------------
//  Tier B buildings are GPU-instanced and therefore share UVs; they cannot
//  carry a unique lightmap. Position-dependent bounce light instead comes from
//  a 64 x 12 x 64 probe grid baked in Cycles (build/bake_irradiance.py).
//
//  Encoding, chosen to fit the 300 KB/set budget: one RGBA8 3D texture where
//  RGB is ambient irradiance scaled by a per-set exponent and A is directional
//  visibility along the set's dominant light axis — the L1 term reconstructed
//  in-shader as ambient + sky*A*max(0,N.up) + sun*A*max(0,N.L).
//  64*12*64*4 = 196 608 bytes.
// ============================================================================
export class IrradianceGrid {
  constructor(THREE) {
    this.THREE = THREE;
    this.uniforms = {
      irrTex:   {value: null},
      irrMin:   {value: new THREE.Vector3(-860, -20, -890)},
      irrSize:  {value: new THREE.Vector3(1720, 260, 1560)},
      irrScale: {value: 1.0},
      irrSun:   {value: new THREE.Vector3(0.45, 0.14, 0.88)},
      irrSunCol:{value: new THREE.Color(1, 1, 1)},
      irrSkyCol:{value: new THREE.Color(0.5, 0.6, 0.9)},
      irrMix:   {value: 0.0},
      irrTexB:  {value: null},
      irrScaleB:{value: 1.0},
      irrSunB:  {value: new THREE.Vector3(0.45, 0.14, 0.88)},
      irrSunColB:{value: new THREE.Color(1, 1, 1)},
      irrSkyColB:{value: new THREE.Color(0.5, 0.6, 0.9)},
    };
    this.materials = new Set();
    this.enabled = false;
  }

  /** Build a Data3DTexture from a packed RGBA8 payload. */
  setGrid(slot, {data, dims, bounds, scale, sun, sunColor, skyColor}) {
    const T = this.THREE;
    const tex = new T.Data3DTexture(new Uint8Array(data), dims[0], dims[1], dims[2]);
    tex.format = T.RGBAFormat;
    tex.type = T.UnsignedByteType;
    tex.minFilter = tex.magFilter = T.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = T.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    const u = this.uniforms;
    if (slot === 'A') {
      u.irrTex.value = tex; u.irrScale.value = scale;
      u.irrSun.value.set(...sun).normalize();
      u.irrSunCol.value.setRGB(...sunColor); u.irrSkyCol.value.setRGB(...skyColor);
    } else {
      u.irrTexB.value = tex; u.irrScaleB.value = scale;
      u.irrSunB.value.set(...sun).normalize();
      u.irrSunColB.value.setRGB(...sunColor); u.irrSkyColB.value.setRGB(...skyColor);
    }
    u.irrMin.value.set(bounds.x0, bounds.y0, bounds.z0);
    u.irrSize.value.set(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0, bounds.z1 - bounds.z0);
    this.enabled = true;
    for (const m of this.materials) m.needsUpdate = true;
    return tex;
  }

  /** Patch a MeshStandardMaterial to add the volume's indirect diffuse. */
  attach(mat) {
    if (mat.userData.__irr) return mat;
    mat.userData.__irr = true;
    this.materials.add(mat);
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vIrrWorld;')
        .replace('#include <project_vertex>', `#include <project_vertex>
  #ifdef USE_INSTANCING
    vIrrWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  #else
    vIrrWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  #endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vIrrWorld;
uniform highp sampler3D irrTex;   // GLSL ES 3.0 has no default sampler3D precision
uniform highp sampler3D irrTexB;
uniform vec3 irrMin, irrSize, irrSun, irrSunB;
uniform vec3 irrSunCol, irrSkyCol, irrSunColB, irrSkyColB;
uniform float irrScale, irrScaleB, irrMix;
vec3 sampleIrr( highp sampler3D t, float sc, vec3 sunDir, vec3 sunCol, vec3 skyCol, vec3 N ) {
  vec3 uvw = clamp( ( vIrrWorld - irrMin ) / irrSize, vec3(0.002), vec3(0.998) );
  vec4 p = texture( t, uvw );
  vec3 ambient = pow( p.rgb, vec3( 2.2 ) ) * sc;   // undo the storage gamma
  float vis = p.a;
  return ambient
       + skyCol * vis * max( 0.0, N.y ) * 0.5
       + sunCol * vis * max( 0.0, dot( N, sunDir ) ) * 0.35;
}`)
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectDiffuse )
  {
    vec3 nrm = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );  // view -> world
    vec3 irrA = sampleIrr( irrTex, irrScale, irrSun, irrSunCol, irrSkyCol, nrm );
    vec3 irrB = sampleIrr( irrTexB, irrScaleB, irrSunB, irrSunColB, irrSkyColB, nrm );
    irradiance += mix( irrA, irrB, irrMix );
  }
#endif`);
    };
    mat.needsUpdate = true;
    return mat;
  }

  setMix(t) { this.uniforms.irrMix.value = t; }
  dispose(slot) {
    const u = slot === 'A' ? this.uniforms.irrTex : this.uniforms.irrTexB;
    u.value?.dispose(); u.value = null;
  }
}
