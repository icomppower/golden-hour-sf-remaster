// ============================================================================
//  contact_shadows.js — soft ground contact for the dynamic objects
//  ---------------------------------------------------------------------------
//  Baked lighting owns the static scene, so the engine's realtime sun and its
//  shadow maps are gone. Cars, the cable cars and the police cruiser would then
//  float: nothing anchors them to the road. This puts a cheap soft disc under
//  every moving object, sampled against the same groundH the physics uses, so
//  the contact reads correctly on hills and on the bridge decks.
//
//  One InstancedMesh, one 64px alpha texture, no lights, no shadow maps.
// ============================================================================
export class ContactShadows {
  constructor(THREE, scene, groundH, capacity = 48) {
    this.THREE = THREE;
    this.groundH = groundH;
    this.capacity = capacity;

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    // Greyscale on black: three samples alphaMap's GREEN channel, and a canvas
    // gradient that fades the alpha channel instead comes back premultiplied
    // and reads as a solid disc.
    g.fillStyle = '#000';
    g.fillRect(0, 0, 64, 64);
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.5, '#9e9e9e');
    grad.addColorStop(1, '#000000');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: tex, transparent: true, opacity: 0.34,
      depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'contact_shadows';
    this.mesh.count = 0;
    scene.add(this.mesh);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._Y = new THREE.Vector3(0, 1, 0);
  }

  /** Follow the ground normal so the disc lies flat on hills and ramps. */
  place(i, x, z, radius) {
    const e = 1.4, gh = this.groundH;
    this._up.set(gh(x - e, z) - gh(x + e, z), 2 * e, gh(x, z - e) - gh(x, z + e)).normalize();
    this._q.setFromUnitVectors(this._Y, this._up);
    this._p.set(x, gh(x, z) + 0.09, z);
    this._s.set(radius, 1, radius);
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m);
  }

  update(sources) {
    const n = Math.min(sources.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      this.place(i, s.x, s.z, s.r);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setOpacity(v) { this.mesh.material.opacity = v; }
}
