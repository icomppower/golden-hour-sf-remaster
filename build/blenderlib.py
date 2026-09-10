# ============================================================================
#  blenderlib.py — shared Blender-side helpers for the SF remaster pipeline
#  Imported by build_city.py, make_landmark_assets.py and bake_irradiance.py.
# ============================================================================
import bpy, bmesh, json, math, os, sys, time
import numpy as np
from mathutils import Matrix, Vector, Euler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T0 = time.time()

def argv_list():
    return sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
def arg(name, default=None):
    a = argv_list()
    return a[a.index(name)+1] if name in a else default
def flag(name):
    return name in argv_list()
TAG = 'build'
def set_tag(t):
    global TAG
    TAG = t
def log(*a):
    print(f'[{TAG} {time.time()-T0:6.1f}s]', *a, flush=True)

# ---------------------------------------------------------------- data ------
CITY_JS = arg('--city', os.path.join(ROOT, 'build/city.json'))
with open(CITY_JS) as f:
    CITY = json.load(f)
BIN = np.fromfile(CITY_JS.replace('.json', '.bin'), dtype=np.uint8)
D   = CITY['D']

def buf(desc, dtype=np.float32):
    if desc is None:
        return None
    t = {'Float32Array': np.float32, 'Uint32Array': np.uint32}[desc['type']]
    return BIN[desc['off']:desc['off'] + desc['count']*np.dtype(t).itemsize].view(t)

# three.js is Y-up / -Z forward; Blender is Z-up. (x,y,z)_three -> (x,-z,y)_blender
T2B = Matrix(((1,0,0,0), (0,0,-1,0), (0,1,0,0), (0,0,0,1)))
B2T = T2B.inverted()
def m4(elements):                       # three column-major 16 -> Blender matrix
    m = Matrix([[elements[c*4+r] for c in range(4)] for r in range(4)])
    return T2B @ m @ B2T
def p3(x, y, z):
    return Vector((x, -z, y))

# ---------------------------------------------------------------- scene -----
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.render.engine = 'CYCLES'
    return sc
_COLL = None
def set_collection(c):
    global _COLL
    _COLL = c
    return c
def coll():
    global _COLL
    if _COLL is None:
        _COLL = bpy.context.collection
    return _COLL

def new_mesh_obj(name, verts, faces, uvs=None, cols=None, matrix=None, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    if cols is not None:
        ca = me.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='POINT')
        flat = np.zeros((len(verts), 4), dtype=np.float32)
        flat[:, :3] = cols
        flat[:, 3]  = 1.0
        ca.data.foreach_set('color', flat.ravel())
    if uvs is not None:
        uvl = me.uv_layers.new(name='UVMap')
        loop_uv = np.zeros((len(me.loops), 2), dtype=np.float32)
        for i, l in enumerate(me.loops):
            loop_uv[i] = uvs[l.vertex_index]
        uvl.data.foreach_set('uv', loop_uv.ravel())
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    if matrix is not None:
        ob.matrix_world = matrix
    coll().objects.link(ob)
    return ob

def obj_from_record(rec, name=None, matrix=None):
    """Rebuild an extracted three.js mesh as a Blender object, verbatim."""
    g   = rec['geometry']
    pos = buf(g['position']).reshape(-1, 3)
    idx = buf(g.get('index'), np.uint32)
    verts = [(float(x), -float(z), float(y)) for x, y, z in pos]
    if idx is not None:
        tri = idx.reshape(-1, 3)
    else:
        tri = np.arange(len(pos), dtype=np.uint32).reshape(-1, 3)
    faces = [tuple(int(i) for i in t) for t in tri]
    cols = None
    if g.get('color') is not None:
        cols = buf(g['color']).reshape(-1, 3)
    uvs = None
    if g.get('uv') is not None:
        uvs = buf(g['uv']).reshape(-1, 2)
    return new_mesh_obj(name or f"obj{rec['id']}", verts, faces, uvs, cols,
                        matrix if matrix is not None else m4(rec['matrix']))

def by_kind(kind):
    return [o for o in CITY['objects'] if o['kind'] == kind]

# ---------------------------------------------------------------- materials -
MATS = {}
def srgb_to_linear(c):
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
def hex_rgb(h, default=(0.8, 0.8, 0.8)):
    if not h:
        return default
    h = h.lstrip('#')
    return tuple(srgb_to_linear(int(h[i:i+2], 16)/255) for i in (0, 2, 4))

def pbr(name, color=(0.8,0.8,0.8), rough=0.8, metal=0.0, emission=None,
        emit_strength=0.0, vcol=False, tex=None, normal_tex=None, alpha=1.0):
    if name in MATS:
        return MATS[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt  = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value  = rough
    bsdf.inputs['Metallic'].default_value   = metal
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        mat.blend_method = 'BLEND'
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1)
        bsdf.inputs['Emission Strength'].default_value = emit_strength
    if vcol:
        n = nt.nodes.new('ShaderNodeVertexColor'); n.layer_name = 'Col'
        n.location = (-400, 200)
        nt.links.new(n.outputs['Color'], bsdf.inputs['Base Color'])
    if tex is not None:
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = tex
        n.location = (-500, 300)
        nt.links.new(n.outputs['Color'], bsdf.inputs['Base Color'])
    if normal_tex is not None:
        ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = normal_tex
        ti.image.colorspace_settings.name = 'Non-Color'
        ti.location = (-700, -200)
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.location = (-400, -200)
        nt.links.new(ti.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    MATS[name] = mat
    return mat

def assign(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    return ob

