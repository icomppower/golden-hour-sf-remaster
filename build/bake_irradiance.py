# ============================================================================
#  bake_irradiance.py — probe-grid sampling pass
#  ---------------------------------------------------------------------------
#  The Tier B filler buildings are GPU-instanced and cannot carry a lightmap,
#  so their position-dependent bounce light comes from a coarse irradiance
#  volume: 64 x 12 x 64 probes over the whole map.
#
#  Sampling trick: every probe is one small up-facing quad, UV-mapped to
#  exactly one texel of a 256 x 192 image (256*192 == 64*12*64). A single
#  Cycles DIFFUSE bake therefore fills the entire volume in one pass, and a
#  second AO bake fills the directional-visibility channel. The quads are
#  invisible to every ray type but their own bake, so they do not pollute the
#  scene they are measuring.
#
#  Payload: 64*12*64*4 = 196 608 bytes, inside the 300 KB/set budget.
# ============================================================================
import bpy, json, math, os, time
import numpy as np
from mathutils import Vector

DIMS = (64, 12, 64)            # x, y, z  — three.js Data3DTexture order
TEX_W, TEX_H = 256, 192        # 49152 texels == 64*12*64
PROBE_QUAD = 0.35              # metres

def _probe_positions(bounds):
    nx, ny, nz = DIMS
    xs = np.linspace(bounds['x0'], bounds['x1'], nx)
    ys = np.linspace(bounds['y0'], bounds['y1'], ny)
    zs = np.linspace(bounds['z0'], bounds['z1'], nz)
    # index = ix + nx*(iy + ny*iz)  — matches THREE.Data3DTexture(w,h,d) layout
    pos = np.zeros((nx*ny*nz, 3), dtype=np.float64)
    for iz in range(nz):
        for iy in range(ny):
            base = nx*(iy + ny*iz)
            pos[base:base+nx, 0] = xs
            pos[base:base+nx, 1] = ys[iy]
            pos[base:base+nx, 2] = zs[iz]
    return pos

def _build_probe_mesh(pos, name='irradiance_probes'):
    n = len(pos)
    h = PROBE_QUAD / 2
    verts = np.zeros((n*4, 3), dtype=np.float64)
    offs = np.array([[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0]])
    for k in range(4):
        verts[k::4] = pos + offs[k]
    faces = [(i*4, i*4+1, i*4+2, i*4+3) for i in range(n)]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate()
    uvl = me.uv_layers.new(name='UV2')
    uv = np.zeros((n*4, 2), dtype=np.float32)
    ix = np.arange(n) % TEX_W
    iy = np.arange(n) // TEX_W
    u0 = (ix + 0.08) / TEX_W; u1 = (ix + 0.92) / TEX_W
    v0 = (iy + 0.08) / TEX_H; v1 = (iy + 0.92) / TEX_H
    uv[0::4] = np.stack([u0, v0], 1)
    uv[1::4] = np.stack([u1, v0], 1)
    uv[2::4] = np.stack([u1, v1], 1)
    uv[3::4] = np.stack([u0, v1], 1)
    loop_uv = np.zeros((len(me.loops), 2), dtype=np.float32)
    for i, l in enumerate(me.loops):
        loop_uv[i] = uv[l.vertex_index]
    uvl.data.foreach_set('uv', loop_uv.ravel())
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    # Measure the scene without lighting it: no shadow, diffuse or glossy
    # response. Camera visibility stays on — clearing every ray-visibility flag
    # drops the object out of the Cycles BVH entirely and the bake comes back
    # black. The quads cover ~0.2% of the map, so their own occlusion is noise.
    ob.visible_diffuse = ob.visible_glossy = False
    ob.visible_transmission = ob.visible_volume_scatter = ob.visible_shadow = False
    return ob

def _white_material(name='probe_white'):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (1, 1, 1, 1)
    b.inputs['Roughness'].default_value = 1.0
    return mat

def bake_volume(bounds, outdir, lighting, theme, log=print, samples=24):
    t0 = time.time()
    scene = bpy.context.scene
    pos = _probe_positions(bounds)
    ob = _build_probe_mesh(pos)
    mat = _white_material()
    ob.data.materials.append(mat)
    nt = mat.node_tree

    def bake_to(image, bake_type):
        node = nt.nodes.get('__probe_bake')
        if node is None:
            node = nt.nodes.new('ShaderNodeTexImage')
            node.name = '__probe_bake'
            uvn = nt.nodes.new('ShaderNodeUVMap')
            uvn.uv_map = 'UV2'
            nt.links.new(uvn.outputs['UV'], node.inputs['Vector'])
        node.image = image
        node.select = True
        nt.nodes.active = node
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        b = scene.render.bake
        b.margin = 0
        if bake_type == 'AO':
            b.use_pass_direct = b.use_pass_indirect = False
        else:
            b.use_pass_direct = b.use_pass_indirect = True
            b.use_pass_color = False
        scene.cycles.bake_type = bake_type
        old = scene.cycles.samples
        scene.cycles.samples = samples
        bpy.ops.object.bake(type=bake_type, use_clear=True, margin=0)
        scene.cycles.samples = old

    amb = bpy.data.images.new('irr_ambient', TEX_W, TEX_H, alpha=False, float_buffer=True)
    amb.colorspace_settings.name = 'Non-Color'
    bake_to(amb, 'DIFFUSE')
    vis = bpy.data.images.new('irr_visibility', TEX_W, TEX_H, alpha=False, float_buffer=True)
    vis.colorspace_settings.name = 'Non-Color'
    bake_to(vis, 'AO')

    a = np.empty(TEX_W*TEX_H*4, dtype=np.float32); amb.pixels.foreach_get(a)
    v = np.empty(TEX_W*TEX_H*4, dtype=np.float32); vis.pixels.foreach_get(v)
    a = a.reshape(-1, 4)[:, :3]
    v = v.reshape(-1, 4)[:, 0]

    lum = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    scale = float(max(np.percentile(lum, 99.0), 1e-4))
    rgb = np.clip(a / scale, 0, 1)
    rgb = np.power(rgb, 1/2.2)                    # cheap gamma, undone in-shader
    out = np.zeros((len(a), 4), dtype=np.uint8)
    out[:, :3] = (rgb * 255 + 0.5).astype(np.uint8)
    out[:, 3] = (np.clip(v, 0, 1) * 255 + 0.5).astype(np.uint8)

    path = os.path.join(outdir, 'irradiance.bin')
    out.tofile(path)
    bpy.data.objects.remove(ob, do_unlink=True)
    for img in (amb, vis):
        bpy.data.images.remove(img)

    sun = theme['sunPos']
    L = math.sqrt(sum(c*c for c in sun)) or 1.0
    meta = dict(
        file='irradiance.bin', dims=list(DIMS), bounds=bounds,
        scale=round(scale, 6), gamma=2.2,
        sun=[sun[0]/L, sun[1]/L, sun[2]/L],
        sunColor=list(_hex_lin(theme['sunColor'])),
        skyColor=list(_hex_lin(theme['hemiSky'])),
    )
    log(f'  irradiance {DIMS} -> {os.path.getsize(path)/1e3:.0f} kB '
        f'scale={scale:.4f} in {time.time()-t0:.1f}s')
    return meta

def _hex_lin(v):
    if isinstance(v, str):
        v = int(v.lstrip('#'), 16)
    r, g, b = (v >> 16) & 255, (v >> 8) & 255, v & 255
    f = lambda c: (c/255/12.92) if c/255 <= 0.04045 else (((c/255)+0.055)/1.055) ** 2.4
    return (round(f(r), 5), round(f(g), 5), round(f(b), 5))
