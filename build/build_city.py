# ============================================================================
#  build_city.py — Blender scene construction + Cycles bake for the SF remaster
#  ---------------------------------------------------------------------------
#  Headless. Reads build/city.json + build/city.bin (the exact upstream world,
#  see build/city_to_json.mjs) and rebuilds it as authored Blender geometry:
#  real terrain, road ribbons, bridge steel, a beveled building kit, trees,
#  lamps, and the landmark assets from assets/landmarks/.
#
#    blender --background --python build/build_city.py -- \
#            --city build/city.json --lighting golden [--stage geometry|bake]
#
#  No manual modelling: every object here is constructed from source data.
# ============================================================================
import bpy, bmesh, json, math, os, re, sys, time
import numpy as np
from mathutils import Matrix, Vector, Euler
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_irradiance
from blenderlib import (ROOT, CITY, BIN, D, buf, m4, p3, T2B, B2T, arg, flag, log, set_tag,
                        reset_scene, new_mesh_obj, obj_from_record, by_kind, coll,
                        pbr, assign, hex_rgb, srgb_to_linear, MATS, set_collection)

LIGHTING = arg('--lighting', 'golden')
STAGE    = arg('--stage', 'geometry')          # geometry | bake
OUTDIR   = arg('--out', os.path.join(ROOT, 'build/blend'))
NO_LANDMARKS = flag('--no-landmarks')
set_tag('build_city')
SCENE = reset_scene()
COLL  = set_collection(bpy.context.collection)


# ---------------------------------------------------------------- carve -----
def _smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)

def switch_path(z):
    """Port of the upstream switchback centreline. Validated against the
    extractor's oracle before use — see carve_switchback()."""
    LB = D['switchback']
    t = min(1.0, max(0.0, (z - LB['z0']) / (LB['z1'] - LB['z0'])))
    x = LB['x'] + LB['amp'] * math.sin(t * math.pi * LB['turns'])
    y = LB['yTop'] + (LB['yBot'] - LB['yTop']) * _smoothstep(0, 1, t)
    return x, y

def switch_height(x, z, edge=7.0, half=5.5):
    LB = D['switchback']
    if z > LB['z0'] + 3 or z < LB['z1'] - 3:
        return None
    px, py = switch_path(min(LB['z0'], max(LB['z1'], z)))
    d = abs(x - px)
    if d > half + edge:
        return None
    return py, _smoothstep(half + edge, half, d)

def carve_switchback(ob, oracle):
    """Cut the Lombard switchback into the terrain.

    Upstream builds the terrain mesh from terrainH but drives the car on
    groundH, and groundH drops 57 m into the hill along the switchback. The
    result is that Lombard Street — Tier A hero geometry in this spec — is
    buried inside Russian Hill and the car drives through rock. Coordinates do
    not move; the ground is remastered to be the surface the physics already
    uses. The corridor is subdivided first, because the 7 m terrain grid would
    otherwise turn a 12 m road cut into a spike.
    """
    me = ob.data
    LB = D['switchback']
    zs = np.linspace(LB['z1'], LB['z0'], 40)
    path = np.array([[switch_path(float(z))[0], -float(z)] for z in zs])   # blender xy

    # --- validate the port against the extractor's oracle -------------------
    if oracle is not None:
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        worst = 0.0
        for i, v in enumerate(co):
            x, z = float(v[0]), float(-v[1])
            r = switch_height(x, z)
            want = float(oracle[i*3 + 1])
            got = v[2] if r is None else v[2] + (r[0] - v[2]) * r[1]
            worst = max(worst, abs(got - want))
        assert worst < 0.05, f'switchback port disagrees with the extractor by {worst:.3f} m'
        log(f'  switchback port matches the extractor oracle (max {worst:.4f} m)')

    # --- subdivide the corridor --------------------------------------------
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    sel = []
    for f in bm.faces:
        c = f.calc_center_median()
        if np.min(np.hypot(path[:, 0] - c.x, path[:, 1] - c.y)) < 34.0:
            sel.append(f)
    if sel:
        edges = list({e for f in sel for e in f.edges})
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=8, use_grid_fill=True)
    # --- carve --------------------------------------------------------------
    moved = 0
    deepest = 0.0
    for v in bm.verts:
        # Same falloff as upstream groundH: a wider carve looks smoother but
        # drops the terrain below the surface the car actually drives on
        # everywhere the centreline swings away. Local subdivision, not a wider
        # blend, is what keeps the 12 m cut from turning into a spike.
        r = switch_height(v.co.x, -v.co.y, edge=7.0)
        if r is None:
            continue
        ny = v.co.z + (r[0] - v.co.z) * r[1]
        if abs(ny - v.co.z) > 0.01:
            moved += 1
            deepest = max(deepest, v.co.z - ny)
        v.co.z = ny
    bm.to_mesh(me)
    bm.free()
    me.calc_loop_triangles()
    # measure the cut against the surface the physics uses, right here rather
    # than only in the browser gate: a raycast down the centreline must land on
    # the road height everywhere
    dg = bpy.context.evaluated_depsgraph_get()
    ob.update_tag()
    worst, worst_z = 0.0, 0.0
    LBz0, LBz1 = LB['z0'], LB['z1']
    for z in np.linspace(LBz0 - 2, LBz1 + 2, 60):
        px, py = switch_path(float(z))
        origin = Vector((px, -float(z), py + 40.0))
        hit, loc, _, _ = ob.ray_cast(origin, Vector((0, 0, -1)), distance=120.0)
        if not hit:
            worst, worst_z = 999.0, float(z)
            break
        e = abs(loc.z - py)
        if e > worst:
            worst, worst_z = e, float(z)
    log(f'  lombard carve: {moved} vertices moved, deepest {deepest:.1f} m, '
        f'{len(me.vertices)} terrain verts, worst centreline error '
        f'{worst:.2f} m at z={worst_z:.0f}')

# ---------------------------------------------------------------- terrain ---
def build_terrain():
    rec = by_kind('terrain')[0]
    ob  = obj_from_record(rec, 'terrain')
    carve_switchback(ob, buf(rec['geometry'].get('carve')))
    me  = ob.data
    for p in me.polygons:
        p.use_smooth = True
    # world-space UVs for the detail/normal texture (metres -> uv, 24 m tile)
    uvl = me.uv_layers.new(name='UVMap')
    co = np.empty(len(me.vertices)*3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    loop_v = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', loop_v)
    uv = co[loop_v][:, :2] / 24.0
    uvl.data.foreach_set('uv', uv.ravel())
    assign(ob, pbr('terrain', rough=0.95, vcol=True))
    log(f'terrain: {len(me.vertices)} verts')
    return ob

# ---------------------------------------------------------------- roads -----
def build_roads():
    out = []
    rec = by_kind('roads')[0]
    ob  = obj_from_record(rec, 'roads')
    assign(ob, pbr('asphalt', color=hex_rgb('#0d0d0f'), rough=0.62, vcol=True))
    out.append(ob)
    lom = by_kind('lombard')
    if lom:
        lo = obj_from_record(lom[0], 'lombard_street')
        assign(lo, pbr('brick_road', color=hex_rgb('#b0563c'), rough=0.78))
        out.append(lo)
    # lane dashes: thousands of tiny quads -> one merged mesh, cheaper than instancing
    dash = by_kind('road_dashes')
    if dash:
        rec = dash[0]
        g   = rec['geometry']
        pos = buf(g['position']).reshape(-1, 3)
        idx = buf(g.get('index'), np.uint32).reshape(-1, 3)
        mats = buf(rec['instances']['matrices']).reshape(-1, 16)
        base = m4(rec['matrix'])
        verts, faces = [], []
        for k in range(rec['instances']['count']):
            M = base @ m4(mats[k])
            o = len(verts)
            for x, y, z in pos:
                v = M @ Vector((float(x), -float(z), float(y), 1.0))
                verts.append((v.x, v.y, v.z))
            faces.extend([(int(a)+o, int(b)+o, int(c)+o) for a, b, c in idx])
        dm = new_mesh_obj('road_dashes', verts, faces)
        assign(dm, pbr('lane_paint', color=hex_rgb('#f0e4b8'), rough=0.55))
        out.append(dm)
        log(f'dashes: {rec["instances"]["count"]} quads merged')
    return out

# ---------------------------------------------------------------- lamps -----
def build_lamps():
    out = []
    for kind, matname, color, rough, emit, strength in (
            ('lamp_pole', 'lamp_pole', '#2a2a30', 0.55, None, 0.0),
            ('lamp_head', 'lamp_head', '#332a20', 0.4, '#ffbf7a', 4.0)):
        recs = by_kind(kind)
        if not recs:
            continue
        rec = recs[0]
        g   = rec['geometry']
        pos = buf(g['position']).reshape(-1, 3)
        idx = buf(g.get('index'), np.uint32)
        tri = idx.reshape(-1, 3) if idx is not None else np.arange(len(pos)).reshape(-1, 3)
        mats = buf(rec['instances']['matrices']).reshape(-1, 16)
        base = m4(rec['matrix'])
        verts, faces = [], []
        for k in range(rec['instances']['count']):
            M = base @ m4(mats[k])
            o = len(verts)
            for x, y, z in pos:
                v = M @ Vector((float(x), -float(z), float(y), 1.0))
                verts.append((v.x, v.y, v.z))
            faces.extend([(int(a)+o, int(b)+o, int(c)+o) for a, b, c in tri])
        ob = new_mesh_obj(kind, verts, faces, smooth=(kind == 'lamp_head'))
        assign(ob, pbr(matname, color=hex_rgb(color), rough=rough,
                       emission=hex_rgb(emit) if emit else None, emit_strength=strength))
        out.append(ob)
        log(f'{kind}: {rec["instances"]["count"]} instances merged')
    return out

# ---------------------------------------------------------------- buildings -
def decompose_instances(rec):
    """-> list of (loc, rotZ, scale) in Blender space for an InstancedMesh."""
    mats = buf(rec['instances']['matrices']).reshape(-1, 16)
    base = m4(rec['matrix'])
    out  = []
    for k in range(rec['instances']['count']):
        M = base @ m4(mats[k])
        loc, quat, scl = M.decompose()
        out.append((loc, quat.to_euler('XYZ').z, scl))
    return out

KIT_BUCKETS = [  # (name, median w, median h, median d) chosen from the extracted spread
    ('low_small', 16, 34, 16), ('low_wide', 26, 34, 26),
    ('mid_small', 16, 62, 16), ('mid_wide', 26, 62, 26),
    ('high',      20, 110, 20), ('tower',   24, 165, 24),
]
def kit_mesh(name, w, h, d, facade_mat):
    """A beveled block with a plinth, cornice band and rooftop parapet.
    Authored at the bucket's median size so per-instance scale stays near 1
    and the bevels/ledges do not visibly stretch."""
    bm = bmesh.new()
    def box(cx, cy, cz, sx, sy, sz):
        r = bmesh.ops.create_cube(bm, size=1.0)
        vs = r['verts']
        bmesh.ops.scale(bm, vec=Vector((sx, sy, sz)), verts=vs)
        bmesh.ops.translate(bm, vec=Vector((cx, cy, cz)), verts=vs)
        return vs
    # main shaft (local Z spans -h/2 .. +h/2, matching the upstream instance box)
    box(0, 0, 0, w, d, h)
    # plinth at street level: upstream sinks the box 16 m, so the visible base is at -h/2+16
    base_z = -h/2 + 16
    box(0, 0, base_z + 1.2, w*1.06, d*1.06, 2.4)
    # cornice + parapet at the top
    box(0, 0, h/2 - 1.0, w*1.05, d*1.05, 2.0)
    box(0, 0, h/2 + 1.2, w*0.98, d*0.98, 2.4)
    # rooftop plant box, offset so silhouettes differ between kit variants
    box(w*0.16, d*0.10, h/2 + 3.6, w*0.3, d*0.3, 4.2)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.bevel(bm, geom=list(bm.verts)+list(bm.edges)+list(bm.faces),
                    offset=0.22, segments=2, affect='EDGES', clamp_overlap=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    # box-project UVs at a fixed world scale so window rows line up across the kit
    uvl = me.uv_layers.new(name='UVMap')
    WIN_W, WIN_H = 4.0, 3.6           # metres per facade tile
    uv = np.zeros((len(me.loops), 2), dtype=np.float32)
    for poly in me.polygons:
        n = poly.normal
        up = abs(n.z) > 0.7
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if up:
                uv[li] = (co.x/WIN_W, co.y/WIN_W)
            elif abs(n.x) > abs(n.y):
                uv[li] = (co.y/WIN_W, co.z/WIN_H)
            else:
                uv[li] = (co.x/WIN_W, co.z/WIN_H)
    uvl.data.foreach_set('uv', uv.ravel())
    me.materials.append(facade_mat)
    return me

def build_buildings(facade_mat, g):
    rec = by_kind('buildings')[0]
    inst = decompose_instances(rec)
    colors = buf(rec['instances'].get('colors'))
    colors = colors.reshape(-1, 3) if colors is not None else None
    kits = {}
    parents = {}
    def parent_for(cell, lod=False):
        key = (cell, lod)
        if key not in parents:
            n = 'bldglod' if lod else 'buildings'
            e = bpy.data.objects.new(f'{n}_c{cell[0]}{cell[1]}', None)
            COLL.objects.link(e)
            parents[key] = e
        return parents[key]
    for i, (loc, rotz, scl) in enumerate(inst):
        w, h, d = float(scl.x), float(scl.z), float(scl.y)
        if h < 48:   bucket = 0 if max(w, d) < 21 else 1
        elif h < 86: bucket = 2 if max(w, d) < 21 else 3
        elif h < 130: bucket = 4
        else:         bucket = 5
        name, kw, kh, kd = KIT_BUCKETS[bucket]
        if name not in kits:
            kits[name] = kit_mesh(f'kit_{name}', kw, kh, kd, facade_mat)
        ob = bpy.data.objects.new(f'bldg_{i:04d}', kits[name])
        ob.matrix_world = (Matrix.Translation(loc) @ Matrix.Rotation(rotz, 4, 'Z')
                           @ Matrix.Diagonal((w/kw, d/kd, h/kh, 1.0)))
        if colors is not None:
            ob.color = (*[srgb_to_linear(float(c)) for c in colors[i]], 1.0)
        cell = chunk_of(float(loc.x), float(-loc.y), g)
        ob.parent = parent_for(cell, False)
        COLL.objects.link(ob)
        lo = bpy.data.objects.new(f'bldglod_{i:04d}', lod_mesh(kits[name]))
        lo.matrix_world = ob.matrix_world.copy()
        lo.color = ob.color
        lo.parent = parent_for(cell, True)
        COLL.objects.link(lo)
    log(f'buildings: {len(inst)} instances over {len(kits)} kit meshes '
        f'(+LOD1), {len(parents)} chunk groups')
    return list(parents.values()), list(kits.values())

# ---------------------------------------------------------------- trees -----
def tree_mesh(name):
    """Low-poly conifer: tapered trunk plus three offset cone tiers."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=6,
                          radius1=0.22, radius2=0.14, depth=2.2,
                          matrix=Matrix.Translation((0, 0, 1.1)))
    for z, r, hgt in ((1.9, 1.55, 2.6), (3.0, 1.15, 2.3), (4.0, 0.72, 2.0)):
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=7,
                              radius1=r, radius2=0.02, depth=hgt,
                              matrix=Matrix.Translation((0, 0, z + hgt/2)))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    return me

def build_trees(g):
    rec = by_kind('trees')[0]
    inst = decompose_instances(rec)
    me = tree_mesh('kit_tree')
    me.materials.append(pbr('foliage', color=hex_rgb('#2b4026'), rough=0.95))
    parents = {}
    def parent_for(cell, lod=False):
        key = (cell, lod)
        if key not in parents:
            n = 'treelod' if lod else 'trees'
            e = bpy.data.objects.new(f'{n}_c{cell[0]}{cell[1]}', None)
            COLL.objects.link(e)
            parents[key] = e
        return parents[key]
    for i, (loc, rotz, scl) in enumerate(inst):
        ob = bpy.data.objects.new(f'tree_{i:04d}', me)
        # upstream cone: centre at h + 2.6*s, height 5.5*s -> base sits at h - 0.15*s
        s = float(scl.x)
        ob.matrix_world = (Matrix.Translation(Vector((loc.x, loc.y, loc.z - 2.6*s)))
                           @ Matrix.Rotation(rotz, 4, 'Z') @ Matrix.Diagonal((s, s, s, 1.0)))
        cell = chunk_of(float(loc.x), float(-loc.y), g)
        ob.parent = parent_for(cell, False)
        COLL.objects.link(ob)
        lo = bpy.data.objects.new(f'treelod_{i:04d}', lod_mesh(me))
        lo.matrix_world = ob.matrix_world.copy()
        lo.parent = parent_for(cell, True)
        COLL.objects.link(lo)
    log(f'trees: {len(inst)} instances (+LOD1), {len(parents)} chunk groups')
    return list(parents.values())


# ---------------------------------------------------------------- LODs ------
LOD_CACHE = {}

def lod_mesh(me, ratio=0.35):
    """A decimated twin of an instanced kit mesh. Shipped as a second instancing
    group per chunk with identical transforms — glTF instancing drops mesh names
    and every kit shares its topology, so there is no key to match a lone proxy
    against at runtime. The extra instance table is a few kB."""
    if me.name in LOD_CACHE:
        return LOD_CACHE[me.name]
    dup = me.copy()
    dup.name = me.name + '_lod1'
    tmp = bpy.data.objects.new('__lodsrc', dup)
    COLL.objects.link(tmp)
    mod = tmp.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = ratio
    dg = bpy.context.evaluated_depsgraph_get()
    baked = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    baked.name = me.name + '_lod1'
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.meshes.remove(dup)
    LOD_CACHE[me.name] = baked
    return baked

# ---------------------------------------------------------------- bridges ---
def build_bridges():
    recs = by_kind('bridge')
    steel_gg = pbr('steel_orange', color=hex_rgb('#e0451f'), rough=0.45, metal=0.35)
    steel_bb = pbr('steel_grey',   color=hex_rgb('#9aa0a8'), rough=0.42, metal=0.55)
    concrete = pbr('pier_concrete', color=hex_rgb('#bfb8ac'), rough=0.9)
    beacon   = pbr('beacon_red', color=hex_rgb('#ff2211'), rough=0.4,
                   emission=hex_rgb('#ff2211'), emit_strength=8.0)
    objs = []
    for rec in recs:
        m = rec['material'] if isinstance(rec['material'], dict) else rec['material'][0]
        ob = obj_from_record(rec, f"bridge_{rec['id']}")
        col = (m or {}).get('color') or '#9aa0a8'
        if (m or {}).get('emissiveIntensity', 0) > 1:
            mat = beacon
        elif col.lower() == '#bfb8ac':
            mat = concrete
        elif col.lower() == '#e0451f':
            mat = steel_gg
        else:
            mat = steel_bb
        # cable tubes and beacons read as round; boxes stay faceted
        if rec['geometry']['type'] in ('TubeGeometry', 'SphereGeometry', 'CylinderGeometry'):
            for p in ob.data.polygons:
                p.use_smooth = True
        assign(ob, mat)
        objs.append(ob)
    merged = []
    for bi, bd in enumerate(D['bridges']):
        axis, line = bd['axis'], bd['line']
        group = [o for o in objs if abs((o.matrix_world.translation.x if axis == 'z'
                 else -o.matrix_world.translation.y) - line) < 30]
        if not group:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in group:
            o.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        if len(group) > 1:
            bpy.ops.object.join()
        j = bpy.context.view_layer.objects.active
        j.name = 'bridge_' + ('golden_gate' if bi == 0 else 'bay')
        j.data.name = j.name
        merged.append(j)
        objs = [o for o in objs if o not in group or o is j]
    log(f'bridges: {len(recs)} parts -> {len(merged)} hero objects')
    return merged

# ---------------------------------------------------------------- textures --
def facade_texture(name='facade', size=512):
    """Procedural window grid: albedo with mullions, plus a matching normal map."""
    rng = np.random.default_rng(1337)
    px = np.zeros((size, size, 4), dtype=np.float32)
    px[..., 3] = 1.0
    concrete = np.array([0.72, 0.69, 0.65])
    px[..., :3] = concrete * (0.93 + 0.14*rng.random((size, size, 1)))
    cols = rows = 8
    cw, rh = size//cols, size//rows
    nrm = np.zeros((size, size, 4), dtype=np.float32)
    nrm[..., 0] = 0.5; nrm[..., 1] = 0.5; nrm[..., 2] = 1.0; nrm[..., 3] = 1.0
    for r in range(rows):
        for c in range(cols):
            y0, x0 = r*rh + int(rh*0.18), c*cw + int(cw*0.16)
            y1, x1 = r*rh + int(rh*0.82), c*cw + int(cw*0.84)
            glassy = 0.055 + 0.05*rng.random()
            px[y0:y1, x0:x1, :3] = np.array([glassy*0.9, glassy, glassy*1.25])
            # recessed reveal -> normal map ridges on the window border
            nrm[y0:y0+2, x0:x1, 1] = 0.86
            nrm[y1-2:y1, x0:x1, 1] = 0.14
            nrm[y0:y1, x0:x0+2, 0] = 0.86
            nrm[y0:y1, x1-2:x1, 0] = 0.14
    emi = np.zeros((size, size, 4), dtype=np.float32)
    emi[..., 3] = 1.0
    warm = [(1.0, 0.70, 0.38), (1.0, 0.85, 0.63), (1.0, 0.62, 0.29), (1.0, 0.91, 0.77)]
    rng2 = np.random.default_rng(90210)
    for r in range(rows):
        for c in range(cols):
            if rng2.random() > 0.34:
                continue
            y0, x0 = r*rh + int(rh*0.18), c*cw + int(cw*0.16)
            y1, x1 = r*rh + int(rh*0.82), c*cw + int(cw*0.84)
            emi[y0:y1, x0:x1, :3] = warm[int(rng2.random()*len(warm))]
    alb = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    alb.pixels.foreach_set(px.ravel())
    alb.pack()
    nim = bpy.data.images.new(name+'_n', size, size, alpha=False, float_buffer=False, is_data=True)
    nim.pixels.foreach_set(nrm.ravel())
    nim.pack()
    eim = bpy.data.images.new(name+'_e', size, size, alpha=False, float_buffer=False)
    eim.pixels.foreach_set(emi.ravel())
    eim.pack()
    return alb, nim, eim

def attach_emission_map(mat, image, strength):
    """Lit windows: an emission texture on the shared geometry, whose strength
    the runtime crossfades per lighting set (dark at golden hour, on at night)."""
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    ti = nt.nodes.new('ShaderNodeTexImage')
    ti.image = image
    ti.location = (-600, -260)
    nt.links.new(ti.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = strength
    return mat

# ---------------------------------------------------------------- lighting --
def build_lighting(mode):
    """Golden hour uses a Nishita sky at low sun elevation — the same physical
    model the bake and the runtime environment share. Night swaps the sun for a
    moon lamp and drops the sky to a deep blue gradient."""
    th = CITY['city']['theme']
    sx, sy, sz = th['sunPos']
    d = p3(sx, sy, sz).normalized()
    azimuth = math.atan2(d.y, d.x)
    elevation = math.asin(max(-0.99, min(0.99, d.z)))

    sun = bpy.data.lights.new('sun', 'SUN')
    sob = bpy.data.objects.new('sun', sun)
    COLL.objects.link(sob)
    sob.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()

    world = bpy.data.worlds.new('world')
    SCENE.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes['Background']
    if mode == 'golden':
        sun.energy, sun.angle = 9.0, math.radians(1.1)
        sun.color = hex_rgb('#ffa565')
        sky = nt.nodes.new('ShaderNodeTexSky')
        for st in ('MULTIPLE_SCATTERING', 'NISHITA', 'SINGLE_SCATTERING', 'HOSEK_WILKIE'):
            try:
                sky.sky_type = st
                break
            except TypeError:
                continue
        sky.sun_elevation = max(math.radians(2.0), elevation)
        sky.sun_rotation = azimuth
        if hasattr(sky, 'sun_intensity'):
            sky.sun_intensity = 0.0      # the sun lamp casts the crisp shadow
        for attr, val in (('altitude', 0), ('air_density', 1.9),
                          ('dust_density', 3.4), ('ozone_density', 0.8)):
            if hasattr(sky, attr):
                setattr(sky, attr, val)
        nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 0.42
    else:
        sun.energy, sun.angle = 0.30, math.radians(3.0)
        sun.color = hex_rgb('#9db4e8')
        grad = nt.nodes.new('ShaderNodeTexGradient')
        grad.gradient_type = 'EASING'
        tex = nt.nodes.new('ShaderNodeTexCoord')
        map_ = nt.nodes.new('ShaderNodeMapping')
        map_.inputs['Rotation'].default_value[1] = math.radians(90)
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color = (*hex_rgb('#05070f'), 1)
        ramp.color_ramp.elements[1].color = (*hex_rgb('#131f45'), 1)
        nt.links.new(tex.outputs['Generated'], map_.inputs['Vector'])
        nt.links.new(map_.outputs['Vector'], grad.inputs['Vector'])
        nt.links.new(grad.outputs['Color'], ramp.inputs['Fac'])
        nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 0.55
    log(f'lighting: {mode} sun elev={math.degrees(elevation):.1f} az={math.degrees(azimuth):.1f}')
    return sob

def render_environment(outdir, size=512):
    """Equirect render of the world shader only — the runtime PMREMs it once for
    metal and glass reflections. Geometry is hidden: one probe cannot stand in
    for a whole city, and upstream reflected a gradient sky too."""
    cam_data = bpy.data.cameras.new('env_cam')
    cam_data.type = 'PANO'
    try:
        cam_data.panorama_type = 'EQUIRECTANGULAR'
    except Exception:
        cam_data.cycles.panorama_type = 'EQUIRECTANGULAR'
    cam = bpy.data.objects.new('env_cam', cam_data)
    COLL.objects.link(cam)
    cam.location = (0, 0, 120)
    cam.rotation_euler = (math.radians(90), 0, 0)
    SCENE.camera = cam
    hidden = []
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and ob.visible_camera:
            ob.visible_camera = False
            hidden.append(ob)
    r = SCENE.render
    old = (r.resolution_x, r.resolution_y, r.filepath, r.image_settings.file_format,
           SCENE.cycles.samples)
    r.resolution_x, r.resolution_y = size, size // 2
    r.resolution_percentage = 100
    r.image_settings.file_format = 'PNG'
    r.filepath = os.path.join(outdir, 'env.png')
    SCENE.cycles.samples = 16
    bpy.ops.render.render(write_still=True)
    (r.resolution_x, r.resolution_y, r.filepath, r.image_settings.file_format,
     SCENE.cycles.samples) = old
    for ob in hidden:
        ob.visible_camera = True
    bpy.data.objects.remove(cam, do_unlink=True)
    log(f'environment: env.png {size}x{size//2}')

# ---------------------------------------------------------------- export ----
def export_glb(path, objects=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    if objects is not None:
        for o in objects:
            o.select_set(True)
    kw = dict(filepath=path, export_format='GLB', export_apply=True,
              export_yup=True, export_normals=True, export_texcoords=True,
              export_materials='EXPORT', export_cameras=False, export_lights=False,
              use_selection=objects is not None, export_gpu_instances=True,
              export_gn_mesh=False, export_extras=False)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        for k in ('export_gn_mesh', 'export_gpu_instances', 'export_extras'):
            kw.pop(k, None)
        bpy.ops.export_scene.gltf(**kw)
    log(f'wrote {path} ({os.path.getsize(path)/1e6:.2f} MB)')



# ============================================================================
#  BAKE
#  ---------------------------------------------------------------------------
#  Tier A: ~30 hero objects, unique UV2, packed into one 2048 atlas.
#  Tier B: instanced kit meshes, AO + curvature in the kit's own texture space.
#  Tier C: terrain and roads, 16 tiles matching the chunk grid.
#  All Diffuse / Direct+Indirect with Color OFF, so albedo is never baked twice.
# ============================================================================
GLTF_OUT_GROUP = 'glTF Material Output'

def setup_cycles(samples=64):
    # Device defaults to CPU: Blender 5.2's Metal backend crashes in
    # MetalKernelPipeline::compile (binary-archive serialisation) partway
    # through a multi-tier bake on this machine. CPU bakes the whole city in
    # minutes anyway, so the pipeline is not GPU-bound. --device gpu to retry.
    want = (arg('--device', 'cpu') or 'cpu').upper()
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for dev_type in ('METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
        try:
            prefs.compute_device_type = dev_type
            break
        except TypeError:
            continue
    try:
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
    except Exception:
        pass
    sc = SCENE
    sc.render.engine = 'CYCLES'
    try:
        sc.cycles.device = want
    except Exception:
        sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 4
    sc.cycles.diffuse_bounces = 3
    sc.cycles.glossy_bounces = 1
    sc.cycles.transmission_bounces = 2
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    b = sc.render.bake
    b.use_pass_direct = True
    b.use_pass_indirect = True
    b.use_pass_color = False           # albedo stays in its own texture
    b.margin = 6
    b.use_selected_to_active = False
    sc.cycles.bake_type = 'DIFFUSE'
    log(f'cycles: device={sc.cycles.device} samples={samples}')

def new_lightmap_image(name, size):
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    img.generated_color = (0, 0, 0, 1)
    return img

def gltf_output_group():
    """Node group the glTF exporter reads Occlusion from; carrying an occlusion
    texture is how UV2 survives export. The real lightmap is bound at runtime."""
    ng = bpy.data.node_groups.get(GLTF_OUT_GROUP)
    if ng:
        return ng
    ng = bpy.data.node_groups.new(GLTF_OUT_GROUP, 'ShaderNodeTree')
    ng.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    inp = ng.nodes.new('NodeGroupInput')
    inp.location = (-200, 0)
    return ng

UV2_PLACEHOLDER = None
def uv2_placeholder():
    global UV2_PLACEHOLDER
    if UV2_PLACEHOLDER is None:
        img = bpy.data.images.new('uv2_carrier', 4, 4, alpha=False)
        img.generated_color = (1, 1, 1, 1)
        img.pixels.foreach_set(np.ones(4*4*4, dtype=np.float32))
        img.pack()
        UV2_PLACEHOLDER = img
    return UV2_PLACEHOLDER

def attach_bake_node(mat, image, uv_layer='UV2'):
    """Give a material an active image node on UV2 (the bake target) plus the
    glTF occlusion hookup that forces TEXCOORD_1 into the export."""
    nt = mat.node_tree
    node = mat.node_tree.nodes.get('__bake')
    if node is None:
        node = nt.nodes.new('ShaderNodeTexImage')
        node.name = '__bake'
        node.location = (-900, -500)
        uvn = nt.nodes.new('ShaderNodeUVMap')
        uvn.name = '__bake_uv'
        uvn.uv_map = uv_layer
        uvn.location = (-1100, -500)
        nt.links.new(uvn.outputs['UV'], node.inputs['Vector'])
        # occlusion carrier -> forces the exporter to emit TEXCOORD_1
        carrier = nt.nodes.new('ShaderNodeTexImage')
        carrier.name = '__uv2_carrier'
        carrier.image = uv2_placeholder()
        carrier.location = (-900, -800)
        cuv = nt.nodes.new('ShaderNodeUVMap')
        cuv.uv_map = uv_layer
        cuv.location = (-1100, -800)
        nt.links.new(cuv.outputs['UV'], carrier.inputs['Vector'])
        grp = nt.nodes.new('ShaderNodeGroup')
        grp.node_tree = gltf_output_group()
        grp.name = GLTF_OUT_GROUP
        grp.location = (-600, -800)
        nt.links.new(carrier.outputs['Color'], grp.inputs['Occlusion'])
    node.image = image
    # Do NOT loop over the tree setting .select: in 5.x that resets the active
    # node and the bake reports "no active and selected image texture node".
    node.select = True
    nt.nodes.active = node
    return node

def bake_group(objects, bake_type='DIFFUSE', clear=True):
    for ob in objects:
        uv2 = ob.data.uv_layers.get('UV2')
        if uv2 is not None:
            ob.data.uv_layers.active = uv2
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    SCENE.cycles.bake_type = bake_type
    b = SCENE.render.bake
    if bake_type == 'AO':
        b.use_pass_direct = b.use_pass_indirect = False
    else:
        b.use_pass_direct = b.use_pass_indirect = True
    t = time.time()
    bpy.ops.object.bake(type=bake_type, use_clear=clear, margin=b.margin)
    log(f'  baked {bake_type} over {len(objects)} objects in {time.time()-t:.1f}s')

def encode_lightmap(img, out_png, denoise=True):
    """HDR bake -> sRGB PNG plus the scale that restores it (lightMapIntensity).
    ETC1S is LDR, so the payload is normalised and the exponent travels in JSON."""
    w, h = img.size
    px = np.empty(w*h*4, dtype=np.float32)
    img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[..., :3]
    if denoise:
        k = np.array([1, 4, 6, 4, 1], dtype=np.float32); k /= k.sum()
        for ax in (0, 1):
            px = np.apply_along_axis(lambda m: np.convolve(m, k, mode='same'), ax, px)
    lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    scale = float(max(np.percentile(lum, 99.5), 1e-3))
    norm = np.clip(px / scale, 0, 1)
    srgb = np.where(norm <= 0.0031308, norm*12.92, 1.055*np.power(norm, 1/2.4) - 0.055)
    out = np.zeros((h, w, 4), dtype=np.float32)
    out[..., :3] = srgb
    out[..., 3] = 1.0
    tmp = bpy.data.images.new(img.name + '_png', w, h, alpha=False)
    tmp.pixels.foreach_set(out.ravel())
    tmp.file_format = 'PNG'
    tmp.filepath_raw = out_png
    tmp.save()
    bpy.data.images.remove(tmp)
    return scale

# ---------------------------------------------------------------- tier C ----
def planar_uv2(ob, x0, z0, dx, dz, inset=0.012):
    # Cycles bakes into the mesh's ACTIVE uv layer, not the one wired into the
    # target image node — UV2 has to be made active or the bake lands nowhere.
    me = ob.data
    uvl = me.uv_layers.get('UV2') or me.uv_layers.new(name='UV2')
    me.uv_layers.active = uvl
    co = np.empty(len(me.vertices)*3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    lv = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', lv)
    wx = co[lv][:, 0]
    wy = co[lv][:, 1]                       # blender -y == three +z
    u = (wx - x0) / dx
    v = (wy - (-z0 - dz)) / dz
    u = inset + u * (1 - 2*inset)
    v = inset + v * (1 - 2*inset)
    uvl.data.foreach_set('uv', np.stack([u, v], 1).ravel())
    return uvl

def split_by_chunk(objs, g):
    """Split ground-level meshes along the chunk grid so terrain, roads and
    markings tile exactly with the streaming chunks."""
    out = {}
    for ob in objs:
        me = ob.data
        me.calc_loop_triangles()
        verts = np.empty(len(me.vertices)*3, dtype=np.float32)
        me.vertices.foreach_get('co', verts)
        verts = verts.reshape(-1, 3)
        M = np.array(ob.matrix_world)
        world = verts @ M[:3, :3].T + M[:3, 3]
        polys = [list(p.vertices) for p in me.polygons]
        cent = np.array([world[list(p)].mean(axis=0) for p in polys]) if polys else np.zeros((0, 3))
        ix = np.clip(((cent[:, 0] - g['x0']) / g['dx']).astype(int), 0, g['nx']-1) if len(cent) else []
        iz = np.clip(((-cent[:, 1] - g['z0']) / g['dz']).astype(int), 0, g['nz']-1) if len(cent) else []
        cols = None
        ca = me.color_attributes.get('Col')
        if ca is not None:
            cols = np.empty(len(me.vertices)*4, dtype=np.float32)
            ca.data.foreach_get('color', cols)
            cols = cols.reshape(-1, 4)[:, :3]
        for cell in set(zip(map(int, ix), map(int, iz))):
            sel = [i for i in range(len(polys)) if (ix[i], iz[i]) == cell]
            if not sel:
                continue
            used = sorted({v for i in sel for v in polys[i]})
            remap = {v: k for k, v in enumerate(used)}
            nv = [tuple(float(c) for c in world[v]) for v in used]
            nf = [tuple(remap[v] for v in polys[i]) for i in sel]
            nc = cols[used] if cols is not None else None
            name = f'{ob.name}_c{cell[0]}{cell[1]}'
            nob = new_mesh_obj(name, nv, nf, cols=nc, smooth=any(p.use_smooth for p in me.polygons))
            nob.data.materials.clear()
            for m in me.materials:
                nob.data.materials.append(m)
            out.setdefault(cell, []).append(nob)
        bpy.data.objects.remove(ob, do_unlink=True)
    return out

def bake_tier_c(tiles, g, lighting, outdir):
    """16 tiles: 1024 px for the four centre tiles, 512 elsewhere."""
    centre = {(1, 1), (1, 2), (2, 1), (2, 2)}
    entries, bindings = [], {}
    per_tile = []
    for cell, objs in sorted(tiles.items()):
        size = 1024 if cell in centre else 512
        x0 = g['x0'] + cell[0]*g['dx']
        z0 = g['z0'] + cell[1]*g['dz']
        img = new_lightmap_image(f'lm_terrain_{cell[0]}{cell[1]}', size)
        for ob in objs:
            planar_uv2(ob, x0, z0, g['dx'], g['dz'])
            for mat in ob.data.materials:
                if mat:
                    attach_bake_node(mat, img)
        per_tile.append((cell, objs, img, size))
    for cell, objs, img, size in per_tile:
        for ob in objs:
            for mat in ob.data.materials:
                if mat:
                    attach_bake_node(mat, img)
        bake_group(objs, 'DIFFUSE')
        png = os.path.join(outdir, f'lm_terrain_{cell[0]}{cell[1]}.png')
        scale = encode_lightmap(img, png)
        tid = f'terrain_{cell[0]}{cell[1]}'
        entries.append(dict(id=tid, file=os.path.basename(png), size=size))
        for ob in objs:
            bindings[ob.name] = dict(id=tid, intensity=round(scale, 5), slot='lightMap')
        log(f'  tier C {cell} {size}px scale={scale:.3f} -> {len(objs)} objects')
    return entries, bindings

# ---------------------------------------------------------------- tier A ----
def atlas_uv2(objects, size=2048, margin_px=8, angle_limit=1.4):
    """Unwrap every hero object and pack all of their islands into ONE atlas.

    A per-object grid of cells (the first attempt) wasted about half the atlas
    on empty shelves and gave each landmark ~100 px, which read as scrambled
    noise once the islands were smaller than the ETC1S block size. Packing all
    objects together in a single multi-object edit session lets Blender scale
    islands to a uniform texel density and fill the sheet.
    """
    if not objects:
        return
    for ob in objects:
        me = ob.data
        if me.uv_layers.get('UV2') is None:
            me.uv_layers.new(name='UV2')
        me.uv_layers.active = me.uv_layers['UV2']
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=angle_limit, island_margin=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    margin = margin_px / size
    for kw in (dict(margin=margin, rotate=True, scale=True, merge_overlap=False),
               dict(margin=margin, rotate=True),
               dict(margin=margin)):
        try:
            bpy.ops.uv.pack_islands(**kw)
            break
        except TypeError:
            continue
    bpy.ops.object.mode_set(mode='OBJECT')

    # tripwire: every island must land inside the sheet, or the bake writes
    # outside the atlas and the object samples somebody else's light
    lo, hi = 1e9, -1e9
    for ob in objects:
        uvl = ob.data.uv_layers['UV2']
        uv = np.empty(len(ob.data.loops) * 2, dtype=np.float32)
        uvl.data.foreach_get('uv', uv)
        lo = min(lo, float(uv.min())); hi = max(hi, float(uv.max()))
    assert -0.001 <= lo and hi <= 1.001, f'UV2 outside the atlas: {lo:.3f}..{hi:.3f}'
    log(f'  atlas: {len(objects)} objects packed, uv range {lo:.3f}..{hi:.3f}')

def bake_tier_a(heroes, lighting, outdir, size=2048, sheets=2):
    """Hero lightmaps across `sheets` 2048 atlases.

    One 4096 sheet would give the same texel density but the WASM Basis encoder
    caps a single image at 12 Mpix, and 4096x4096 is 16.8. Two 2048 sheets are
    the same pixels, encode fine, and are what the spec asks for anyway.
    Objects are split greedily by surface area so both sheets carry a similar
    load.
    """
    areas = []
    for ob in heroes:
        ob.data.calc_loop_triangles()
        areas.append(sum(p.area for p in ob.data.polygons))
    order = sorted(range(len(heroes)), key=lambda i: -areas[i])
    groups = [[] for _ in range(sheets)]
    load = [0.0] * sheets
    for i in order:
        k = load.index(min(load))
        groups[k].append(heroes[i])
        load[k] += areas[i]

    entries, bindings = [], {}
    for k, group in enumerate(groups):
        if not group:
            continue
        img = new_lightmap_image(f'lm_hero{k}', size)
        atlas_uv2(group, size)
        for ob in group:
            for mat in ob.data.materials:
                if mat:
                    attach_bake_node(mat, img)
        bake_group(group, 'DIFFUSE')
        png = os.path.join(outdir, f'lm_hero{k}.png')
        scale = encode_lightmap(img, png)
        entries.append(dict(id=f'hero{k}', file=f'lm_hero{k}.png', size=size))
        for ob in group:
            bindings[ob.name] = dict(id=f'hero{k}', intensity=round(scale, 5),
                                     slot='lightMap')
        log(f'  tier A sheet {k}: {size}px scale={scale:.3f} '
            f'-> {len(group)} objects, {load[k]:.0f} m2')
    return entries, bindings

# ---------------------------------------------------------------- tier B ----
def bake_tier_b_ao(kit_objs, outdir, size=1024):
    """Position-independent AO + curvature for the instanced kit, baked in the
    kit's own texture space so GPU instancing survives."""
    if not kit_objs:
        return [], {}
    img = new_lightmap_image('kit_ao', size)
    atlas_uv2(kit_objs, size, angle_limit=1.2)
    for ob in kit_objs:
        for mat in ob.data.materials:
            if mat:
                attach_bake_node(mat, img)
    bake_group(kit_objs, 'AO')
    png = os.path.join(outdir, 'kit_ao.png')
    scale = encode_lightmap(img, png, denoise=False)
    # Keyed by MATERIAL name: GPU instancing collapses the per-object nodes and
    # drops the mesh names, but the material name survives to the runtime and
    # every kit variant shares the one facade material and the one AO atlas.
    bind = {}
    for ob in kit_objs:
        for m in ob.data.materials:
            if m is not None:
                bind[m.name] = dict(id='kit_ao', intensity=round(scale, 5), slot='aoMap')
    return [dict(id='kit_ao', file='kit_ao.png', size=size)], bind

# ---------------------------------------------------------------- world -----
# The eight canonical viewpoints of the visual gate (section 8.4). The landmark
# shots are FRAMED FROM THE GEOMETRY rather than hand-guessed: hand-placed
# cameras ended up pointing at hillsides, which scores the terrain, not the
# landmark. `frame` names the landmark type, `dist` is in bounding-radius units
# and `swing` rotates the camera off the sun axis so the lit face reads.
CAMERAS = [
    dict(id='gg_approach',  x=-300, z=-190, yOff=14, lx=-300, lz=-470, lyOff=10,
         label='Golden Gate approach'),
    dict(id='twin_peaks',   x=-30,  z=60,   yOff=26, lx=170,  lz=-170, lyOff=40,
         label='Twin Peaks overlook'),
    # side-on across the switchback: every view from above it is a 60-degree
    # plunge, because the surrounding hill stands 60 m over the road
    dict(id='lombard',      x=78,   z=-210, yAbove=15, lx=35, lz=-214, lyAbove=7,
         label='Lombard descent'),
    dict(id='chinatown',    frame='gate',       dist=3.0, swing=40, rise=0.55,
         label='Chinatown gate'),
    dict(id='ferry',        frame='clockTower', dist=2.4, swing=-30, rise=0.60,
         label='Ferry Building waterfront'),
    dict(id='castro',       frame='theatre',    dist=3.1, swing=25, rise=0.50,
         label='Castro marquee'),
    dict(id='palace',       frame='rotunda',    dist=2.8, swing=-25, rise=0.55,
         label='Palace of Fine Arts'),
    dict(id='bay_bridge',   x=452,  z=-90,  yOff=8,  lx=300,  lz=-90,  lyOff=6,
         label='Bay Bridge mid-span'),
]

def terrain_sampler(terrain_obj):
    """Nearest-vertex height lookup over the terrain mesh (~7 m grid). Used to
    keep framed cameras above ground: taking the height from the landmark alone
    buried them inside the hill the landmark stands on."""
    from mathutils import kdtree
    me = terrain_obj.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    M = np.array(terrain_obj.matrix_world)
    w = co @ M[:3, :3].T + M[:3, 3]
    tree = kdtree.KDTree(len(w))
    for i, v in enumerate(w):
        tree.insert((float(v[0]), float(v[1]), 0.0), i)
    tree.balance()
    heights = w[:, 2]
    def h(x, z):
        _, i, _ = tree.find((x, -z, 0.0))
        return float(heights[i])
    return h

def frame_cameras(landmark_objs, ground_at=None):
    """Resolve `frame` viewpoints into absolute positions from the placed
    landmark bounding boxes, looking along the sun axis so the lit face shows."""
    boxes = {}
    for ob in landmark_objs:
        t = ob.name.replace('lm_', '').split('.')[0]
        # from the mesh itself: a freshly appended object's bound_box is stale
        # until the depsgraph runs, and a stale box put these cameras underground
        me = ob.data
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get('co', co)
        M = np.array(ob.matrix_world)
        w = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
        xs = w[:, 0]; ys = w[:, 1]; zs = w[:, 2]
        boxes[t] = dict(cx=float((xs.min()+xs.max())/2), cz=float(-(ys.min()+ys.max())/2),
                        base=float(zs.min()), top=float(zs.max()),
                        r=float(max(xs.max()-xs.min(), ys.max()-ys.min(),
                                    zs.max()-zs.min())) / 2)
    sx, sy, sz = CITY['city']['theme']['sunPos']
    L = math.hypot(sx, sz) or 1.0
    sdx, sdz = sx / L, sz / L
    for cam in CAMERAS:
        if 'yAbove' in cam and ground_at is not None:
            cam['y'] = round(ground_at(cam['x'], cam['z']) + cam.pop('yAbove'), 2)
            cam['ly'] = round(ground_at(cam['lx'], cam['lz']) + cam.pop('lyAbove', 0), 2)
            cam.pop('yOff', None); cam.pop('lyOff', None)
            log(f"  camera {cam['id']:12s} over terrain at "
                f"({cam['x']:.0f},{cam['z']:.0f},{cam['y']:.0f})")
            continue
        b = boxes.get(cam.get('frame'))
        if not b:
            continue
        a = math.radians(cam.get('swing', 0))
        dx = sdx * math.cos(a) - sdz * math.sin(a)
        dz = sdx * math.sin(a) + sdz * math.cos(a)
        d = max(b['r'] * cam.get('dist', 2.6), 24.0)
        h = b['top'] - b['base']
        cam['x'] = round(b['cx'] + dx * d, 2)
        cam['z'] = round(b['cz'] + dz * d, 2)
        y = b['base'] + h * cam.get('rise', 0.55) + 4.0
        if ground_at is not None:
            y = max(y, ground_at(cam['x'], cam['z']) + 9.0)
        cam['y'] = round(y, 2)
        cam['lx'] = round(b['cx'], 2)
        cam['lz'] = round(b['cz'], 2)
        cam['ly'] = round(b['base'] + h * 0.45, 2)
        cam.pop('yOff', None); cam.pop('lyOff', None)
        log(f"  camera {cam['id']:12s} frames {cam['frame']:11s} "
            f"at ({cam['x']:.0f},{cam['z']:.0f},{cam['y']:.0f}) r={b['r']:.1f}")
    return CAMERAS

def short_code(label):
    import re as _re
    w = [t for t in _re.split(r'\s+', label.replace('\u00b7', ' ')) if _re.search(r'[A-Za-z0-9]', t)]
    if len(w) >= 2:
        return (w[0][0] + w[1][0] + (w[2][0] if len(w) > 2 else '')).upper()
    return label[:3].upper()

def chunk_grid(nx=4, nz=4):
    m = D['mesh']
    x0, x1 = m['CX'] - m['W']/2, m['CX'] + m['W']/2
    z0, z1 = m['CZ'] - m['D']/2, m['CZ'] + m['D']/2
    return dict(nx=nx, nz=nz, x0=x0, x1=x1, z0=z0, z1=z1,
                dx=(x1-x0)/nx, dz=(z1-z0)/nz)

def chunk_of(x, z, g):
    ix = min(g['nx']-1, max(0, int((x - g['x0']) / g['dx'])))
    iz = min(g['nz']-1, max(0, int((z - g['z0']) / g['dz'])))
    return ix, iz

def write_world_json(chunks, lightmap_bindings=None, irradiance=None):
    lms = []
    for o in D['landmarks']:
        if o['type'] == 'marker':
            continue
        lms.append(dict(x=o['x'], z=o['z'], name=o['label'].upper(), short=short_code(o['label'])))
    for b in D['bridges']:
        s0, s1 = b['span']
        lms.append(dict(x=b['line'] if b['axis'] == 'z' else (s0+s1)/2,
                        z=(s0+s1)/2 if b['axis'] == 'z' else b['line'],
                        name=b['label'].upper(), short=short_code(b['label'])))
    rec = by_kind('buildings')[0]
    mats = buf(rec['instances']['matrices']).reshape(-1, 16)
    base = m4(rec['matrix'])
    blocks = []
    for k in range(rec['instances']['count']):
        M = base @ m4(mats[k])
        loc = M.to_translation()
        blocks.append(dict(x=round(float(loc.x), 2), z=round(float(-loc.y), 2)))
    out = dict(upstreamSha=CITY['meta']['upstreamSha'], bounds=CITY['city']['bounds'],
               chunkGrid=chunk_grid(), chunks=chunks, landmarks=lms, minimapBlocks=blocks,
               cameras=CAMERAS, lightmapBindings=lightmap_bindings or {},
               irradiance=irradiance or {})
    with open(os.path.join(ROOT, 'build/world.json'), 'w') as f:
        json.dump(out, f)
    log(f'world.json: {len(lms)} landmarks, {len(blocks)} minimap blocks, {len(chunks)} chunks')



def bake_irradiance_volume(g, lighting, outdir):
    bounds = dict(x0=g['x0'], x1=g['x1'], z0=g['z0'], z1=g['z1'], y0=-15.0, y1=245.0)
    return bake_irradiance.bake_volume(bounds, outdir, lighting,
                                       CITY['city']['theme'], log=log)

def write_set_json(outdir, lighting, lightmaps, bindings, emissive, irradiance):
    th = CITY['city']['theme']
    night = lighting == 'night'
    sx, sy, sz = th['sunPos']
    L = math.sqrt(sx*sx + sy*sy + sz*sz) or 1.0
    atmo = dict(
        sun=dict(dir=[round(sx/L, 5), round(sy/L, 5), round(sz/L, 5)],
                 color=('#9db4e8' if night else '#ffb37a'),
                 intensity=(0.35 if night else 2.1)),
        skyColor='#%06x' % (0x08122e if night else th['sky'][1] if isinstance(th['sky'], list) else th['sky']['mid']),
        fogColor='#%06x' % (0x121a33 if night else th['fogColor']),
        fogDensity=(0.0013 if night else th['fog']),
        exposure=(1.35 if night else th['exposure']),
    )
    meta = dict(name=lighting, generated=time.strftime('%Y-%m-%dT%H:%M:%SZ'),
                lightmaps=[dict(id=e['id'], file=e['file'].replace('.png', '.ktx2'),
                                size=e['size']) for e in lightmaps],
                bindings=bindings, emissive=emissive, irradiance=irradiance,
                env='env.ktx2', atmosphere=atmo)
    with open(os.path.join(outdir, 'set.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    log(f'set.json: {len(lightmaps)} lightmaps, {len(bindings)} bindings')
    return meta

# ---------------------------------------------------------------- landmarks -
def build_landmarks():
    """Place the authored assets/landmarks/*.blend at their upstream coordinates."""
    idx_path = os.path.join(ROOT, 'assets/landmarks/index.json')
    if not os.path.exists(idx_path):
        log('landmarks: assets/landmarks/index.json missing — run make_landmark_assets.py')
        return []
    with open(idx_path) as f:
        index = json.load(f)
    placed = []
    for e in index:
        path = os.path.join(ROOT, 'assets/landmarks', e['file'])
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = [n for n in src.objects if n.startswith('lm_')]
        for ob in dst.objects:
            if ob is None:
                continue
            COLL.objects.link(ob)
            ob.matrix_world = Matrix.Translation(Vector((e['x'], -e['z'], 0.0))) @ ob.matrix_world
            ob.name = f"lm_{e['type']}"
            placed.append(ob)
    log(f'landmarks: {len(placed)} authored assets placed')
    return placed

# ---------------------------------------------------------------- emission --
def apply_lighting_emission(mode):
    """Golden hour keeps windows and neon nearly dark; night turns them on.
    The per-object values also travel in set.json so the runtime can crossfade."""
    k = 0.10 if mode == 'golden' else 1.0
    table = {}
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        b = mat.node_tree.nodes.get('Principled BSDF')
        if not b:
            continue
        base = mat.get('__emit_base')
        if base is None:
            base = float(b.inputs['Emission Strength'].default_value)
            mat['__emit_base'] = base
        b.inputs['Emission Strength'].default_value = base * k
    for mat in bpy.data.materials:
        base = float(mat.get('__emit_base') or 0.0)
        if base > 0:
            # absolute strength: three maps KHR_materials_emissive_strength
            # straight onto material.emissiveIntensity, so the runtime can set
            # this value directly when it crossfades between sets
            table[mat.name] = round(base * k, 4)
    return table

# ---------------------------------------------------------------- chunking --
CHUNK_SUFFIX = re.compile(r'_c(\d)(\d)(?:\.\d+)?$')

def object_chunk(ob, g):
    """Objects already split along the grid carry their cell in the name.
    Everything else goes by centre, and anything bigger than a chunk becomes
    core geometry that stays resident (the bridges)."""
    m = CHUNK_SUFFIX.search(ob.name)
    if m:
        return f'c{m.group(1)}{m.group(2)}'
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box] if ob.type == 'MESH' else \
         [ob.matrix_world.translation]
    xs = [v.x for v in bb]; ys = [v.y for v in bb]
    diag = math.hypot(max(xs)-min(xs), max(ys)-min(ys))
    if diag > 0.8 * min(g['dx'], g['dz']):
        return 'core'
    cx = sum(xs)/len(xs); cz = -sum(ys)/len(ys)
    ix, iz = chunk_of(cx, cz, g)
    return f'c{ix}{iz}'

def export_chunks(g, lighting):
    """One GLB per chunk plus a core chunk. Parent empties (GPU instancing
    roots) travel with their children."""
    groups = {}
    for ob in list(bpy.data.objects):
        if ob.parent is not None or ob.type not in ('MESH', 'EMPTY'):
            continue
        if ob.type == 'EMPTY' and not ob.children:
            continue
        groups.setdefault(object_chunk(ob, g), []).append(ob)
    start = CITY['city']['start']
    sx, sz = start['x'], start['z']
    six, siz = chunk_of(sx, sz, g)
    chunks = []
    for key, objs in sorted(groups.items()):
        sel = []
        for ob in objs:
            sel.append(ob)
            sel.extend(ob.children_recursive)
        name = f'chunk_{key}'
        path = os.path.join(ROOT, 'build/gltf', name + '.glb')
        export_glb(path, sel)
        if key == 'core':
            bounds = dict(x0=g['x0'], x1=g['x1'], z0=g['z0'], z1=g['z1'])
            first = True
        else:
            ix, iz = int(key[1]), int(key[2])
            bounds = dict(x0=g['x0']+ix*g['dx'], x1=g['x0']+(ix+1)*g['dx'],
                          z0=g['z0']+iz*g['dz'], z1=g['z0']+(iz+1)*g['dz'])
            first = (ix, iz) == (six, siz) or (abs(ix-six) + abs(iz-siz)) == 1
        chunks.append(dict(file=os.path.basename(path), firstPaint=first,
                           bounds=bounds, objects=len(sel)))
    log(f'chunks: {len(chunks)} ({sum(1 for c in chunks if c["firstPaint"])} first-paint)')
    return chunks

# ---------------------------------------------------------------- main ------
def main():
    log(f'city.json objects={len(CITY["objects"])} lighting={LIGHTING} stage={STAGE}')
    g = chunk_grid()
    alb, nrm, emi = facade_texture()
    facade = pbr('facade', rough=0.55, metal=0.0, tex=alb, normal_tex=nrm)
    attach_emission_map(facade, emi, 4.5)

    terrain = build_terrain()
    roads = build_roads()
    lamps = build_lamps()
    bldg_parents, kit_meshes = build_buildings(facade, g)
    tree_parents = build_trees(g)
    bridges = build_bridges()
    landmarks = [] if NO_LANDMARKS else build_landmarks()
    build_lighting(LIGHTING)

    lombard = [o for o in roads if o.name == 'lombard_street']
    ground = [terrain] + [o for o in roads if o not in lombard] + lamps
    heroes = landmarks + bridges + lombard

    frame_cameras(landmarks, terrain_sampler(terrain))
    emissive = apply_lighting_emission(LIGHTING)
    tiles = split_by_chunk(ground, g)
    log(f'ground split into {len(tiles)} chunk tiles')

    lightmaps, bindings = [], {}
    irradiance = None
    if STAGE == 'bake':
        outdir = os.path.join(ROOT, 'build/lighting', LIGHTING)
        os.makedirs(outdir, exist_ok=True)
        setup_cycles(int(arg('--samples', '48')))
        eC, bC = bake_tier_c(tiles, g, LIGHTING, outdir)
        eA, bA = bake_tier_a(heroes, LIGHTING, outdir)
        kit_objs = [o for o in bpy.data.objects
                    if o.type == 'MESH' and o.data in kit_meshes]
        eB, bB = bake_tier_b_ao(kit_objs[:len(kit_meshes)], outdir)
        lightmaps = eC + eA + eB
        bindings = {**bC, **bA, **bB}
        irradiance = bake_irradiance_volume(g, LIGHTING, outdir)
        render_environment(outdir)
        write_set_json(outdir, LIGHTING, lightmaps, bindings, emissive, irradiance)

    for ob in bpy.data.objects:
        if ob.type == 'MESH':
            ob.data.calc_loop_triangles()
    tris = sum(len(o.data.loop_triangles) for o in bpy.data.objects if o.type == 'MESH')
    log(f'scene: {len(bpy.data.objects)} objects, {tris} triangles')

    if flag('--no-export'):
        log('geometry export skipped (--no-export): chunks are shared between sets')
    else:
        chunks = export_chunks(g, LIGHTING)
        write_world_json(chunks)
    os.makedirs(OUTDIR, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUTDIR, f'city_{LIGHTING}.blend'))
    log('done')

main()
