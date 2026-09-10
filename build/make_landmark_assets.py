# ============================================================================
#  make_landmark_assets.py — author assets/landmarks/<type>.blend
#  ---------------------------------------------------------------------------
#  One .blend per landmark type, authored from the exact upstream silhouette
#  (extracted primitives) and then refined: round primitives shaded smooth,
#  edges beveled, real PBR materials in place of the canvas facades, and the
#  whole landmark joined into a single object so it can carry one Tier A
#  lightmap. Geometry is authored at the landmark's own origin, so build_city
#  places it at the upstream coordinate without moving anything.
#
#    blender --background --python build/make_landmark_assets.py
# ============================================================================
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Matrix, Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from blenderlib import (ROOT, CITY, D, buf, m4, arg, log, set_tag, reset_scene,
                        obj_from_record, pbr, hex_rgb, MATS, set_collection, coll)

set_tag('landmarks')
OUT = os.path.join(ROOT, 'assets/landmarks')
os.makedirs(OUT, exist_ok=True)

ROUND = {'CylinderGeometry', 'SphereGeometry', 'ConeGeometry', 'TorusGeometry',
         'TubeGeometry', 'LatheGeometry', 'CircleGeometry'}

# Per-type authoring notes: bevel size and whether the type reads as masonry
# (kept crisp) or as sheet metal / glass (smoothed harder).
TYPE_STYLE = {
    'pyramid':      dict(bevel=0.10, smooth_angle=20),
    'crownTower':   dict(bevel=0.08, smooth_angle=45),
    'darkTower':    dict(bevel=0.08, smooth_angle=30),
    'coitTower':    dict(bevel=0.06, smooth_angle=50),
    'antennaTower': dict(bevel=0.03, smooth_angle=60),
    'cathedral':    dict(bevel=0.05, smooth_angle=25),
    'church':       dict(bevel=0.05, smooth_angle=25),
    'clockTower':   dict(bevel=0.06, smooth_angle=30),
    'domeCivic':    dict(bevel=0.07, smooth_angle=55),
    'rotunda':      dict(bevel=0.07, smooth_angle=55),
    'column':       dict(bevel=0.04, smooth_angle=50),
    'pagoda':       dict(bevel=0.05, smooth_angle=35),
    'rowHouses':    dict(bevel=0.04, smooth_angle=20),
    'theatre':      dict(bevel=0.05, smooth_angle=25),
    'mission':      dict(bevel=0.06, smooth_angle=35),
    'copperTower':  dict(bevel=0.06, smooth_angle=35),
    'glasshouse':   dict(bevel=0.04, smooth_angle=55),
    'windmill':     dict(bevel=0.05, smooth_angle=45),
    'stadium':      dict(bevel=0.06, smooth_angle=30),
    'bottle':       dict(bevel=0.05, smooth_angle=55),
    'islandPrison': dict(bevel=0.06, smooth_angle=25),
    'policeStation':dict(bevel=0.05, smooth_angle=25),
    'gate':         dict(bevel=0.05, smooth_angle=30),
    'wharf':        dict(bevel=0.05, smooth_angle=25),
    'marker':       dict(bevel=0.03, smooth_angle=40),
}

def material_for(desc, tag):
    """Real PBR from the upstream material descriptor."""
    if desc is None:
        return pbr('lm_default', rough=0.8)
    if isinstance(desc, list):
        desc = desc[0] or {}
    col = hex_rgb(desc.get('color'), (0.7, 0.7, 0.7))
    emi = desc.get('emissive')
    ei  = float(desc.get('emissiveIntensity') or 0)
    rough = float(desc.get('roughness', 0.8))
    metal = float(desc.get('metalness', 0.0))
    # upstream leans on emissiveMap for lit windows; keep the glow, drop the canvas
    if desc.get('hasMap') or desc.get('hasEmissiveMap'):
        rough = min(rough, 0.45)
    key = f'{tag}_{desc.get("color")}_{emi}_{ei:.2f}_{rough:.2f}_{metal:.2f}'
    key = key.replace('#', '')
    return pbr(key, color=col, rough=rough, metal=metal,
               emission=hex_rgb(emi) if (emi and ei > 0) else None,
               emit_strength=min(ei * 2.5, 12.0))

def build_type(group):
    ltype = group['type']
    style = TYPE_STYLE.get(ltype, dict(bevel=0.05, smooth_angle=30))
    reset_scene()
    c = set_collection(bpy.context.collection)
    MATS.clear()
    origin = Vector((group['x'], -group['z'], 0.0))       # Blender space
    parts = []
    expect_lo, expect_hi = 1e9, -1e9
    for oid in group['objects']:
        rec = CITY['objects'][oid]
        assert rec['id'] == oid
        ob = obj_from_record(rec, f'part{oid}')
        ob.matrix_world = Matrix.Translation(-origin) @ ob.matrix_world
        # Bake the transform into the mesh. join() keeps only the active object's
        # matrix and the rest is flattened into its local space, so an asset saved
        # with a non-identity transform came back placed at the wrong height.
        ob.data.transform(ob.matrix_world)
        ob.matrix_world = Matrix.Identity(4)
        for v in ob.data.vertices:
            expect_lo = min(expect_lo, v.co.z)
            expect_hi = max(expect_hi, v.co.z)
        mat = material_for(rec['material'], ltype)
        ob.data.materials.clear()
        ob.data.materials.append(mat)
        if rec['geometry']['type'] in ROUND:
            for p in ob.data.polygons:
                p.use_smooth = True
        parts.append(ob)
    if not parts:
        return None

    # bevel every part before joining: after the join, shared material slots and
    # coincident faces would make clamp_overlap misbehave
    for ob in parts:
        dims = max(ob.dimensions)
        off = max(0.012, min(style['bevel'], dims * 0.03))
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        try:
            bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                            offset=off, segments=2, affect='EDGES', clamp_overlap=True,
                            profile=0.6)
        except Exception:
            pass
        bm.to_mesh(ob.data)
        bm.free()

    bpy.ops.object.select_all(action='DESELECT')
    for ob in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = f'lm_{ltype}'
    joined.data.name = f'lm_{ltype}'
    # auto-smooth by angle: domes and tubes round off, masonry stays crisp
    mod = joined.modifiers.new('smooth_by_angle', 'NODES')
    try:
        ng = bpy.data.node_groups.get('Smooth by Angle')
        if ng is None:
            bpy.ops.object.modifier_remove(modifier=mod.name)
            mod = None
        else:
            mod.node_group = ng
    except Exception:
        mod = None

    lcol = bpy.data.collections.new(f'lm_{ltype}')
    bpy.context.scene.collection.children.link(lcol)
    for o in list(c.objects):
        c.objects.unlink(o)
        lcol.objects.link(o)

    zs = [v.co.z for v in joined.data.vertices]
    # tolerance covers the bevel, which grows the silhouette slightly; anything
    # larger means join() moved the geometry and the asset would be misplaced
    assert abs(min(zs) - expect_lo) < 4.0 and abs(max(zs) - expect_hi) < 4.0, \
        f'{ltype}: join moved the geometry ({min(zs):.2f}..{max(zs):.2f} vs ' \
        f'{expect_lo:.2f}..{expect_hi:.2f})'
    assert joined.matrix_world.translation.length < 1e-6, \
        f'{ltype}: asset must be saved with an identity transform'
    tris = len(joined.data.polygons)
    path = os.path.join(OUT, f'{ltype}.blend')
    bpy.ops.wm.save_as_mainfile(filepath=path)
    log(f'{ltype:14s} {len(group["objects"]):3d} parts -> {tris:5d} faces  '
        f'worldY {min(zs):7.1f}..{max(zs):7.1f}  {os.path.basename(path)}')
    return dict(type=ltype, file=f'{ltype}.blend', collection=f'lm_{ltype}',
                parts=len(group['objects']), faces=tris,
                y0=round(min(zs), 3), y1=round(max(zs), 3),
                x=group['x'], z=group['z'], label=group['label'])

def main():
    index = []
    for g in CITY['landmarkGroups']:
        if not g['objects']:
            continue
        r = build_type(g)
        if r:
            index.append(r)
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)
    log(f'{len(index)} landmark assets written to assets/landmarks/')

main()
