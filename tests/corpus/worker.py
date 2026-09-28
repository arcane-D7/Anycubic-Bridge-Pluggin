# S7-003 parity corpus worker — runs inside pinned Blender (headless) via the
# file channel (the MSIX alias does not relay stdout; all results are written
# to the OUT file as JSON). The Node runner (scripts/corpus-runner.mjs) spawns
# us and compares per-op hashes + selection invariants.
#
# Environment:
#   BLENDER_BRIDGE_CORPUS_CONTROL - path to JSON ops control file (from manifest)
#   BLENDER_BRIDGE_CORPUS_OUT     - path to write the results JSON
#   BLENDER_BRIDGE_HEARTBEAT      - optional heartbeat file (touched per op)
#
# Determinism: the canonical hash is sha256 over sorted objects (verts rounded
# to 6dp, sorted polygons, world matrix rounded) — pinned to Blender 5.2.2.

import bmesh
import hashlib
import json
import math
import os
import sys

import bpy  # noqa: F401 — runs inside pinned Blender headless

CONTROL = os.environ.get("BLENDER_BRIDGE_CORPUS_CONTROL", "")
OUT = os.environ.get("BLENDER_BRIDGE_CORPUS_OUT", "")
HB = os.environ.get("BLENDER_BRIDGE_HEARTBEAT", "")
ROUND = 6


def heartbeat():
    if HB:
        try:
            with open(HB, "a") as f:
                f.write(".")
        except Exception:
            pass


def canonical_hash():
    """sha256 over sorted per-object {name, verts(6dp), polys(sort), world(6dp)}."""
    objs = []
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        me = ob.data
        verts = [
            (round(v.co[0], ROUND), round(v.co[1], ROUND), round(v.co[2], ROUND))
            for v in me.vertices
        ]
        polys = sorted(sorted(p.vertices) for p in me.polygons)
        mat = ob.matrix_world
        world = tuple(round(x, ROUND) for row in mat for x in row)
        objs.append({"name": ob.name, "verts": verts, "polys": polys, "world": world})
    objs.sort(key=lambda o: o["name"])
    s = json.dumps(objs, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def selection_snapshot():
    mode = bpy.context.mode
    if mode == "OBJECT":
        return {
            "mode": "object",
            "names": sorted(o.name for o in bpy.context.selected_objects),
        }
    ob = bpy.context.active_object
    if ob is None or ob.type != "MESH":
        return {"mode": "edit", "object": None, "verts": []}
    bm = bmesh.from_edit_mesh(ob.data)
    return {
        "mode": "edit",
        "object": ob.name,
        "verts": sorted(v.index for v in bm.verts if v.select),
        "faces": sorted(f.index for f in bm.faces if f.select)[:50],
        "edges": sorted(e.index for e in bm.edges if e.select)[:50],
    }


# ---------------------------------------------------------------- helpers ---

def select_only(name):
    bpy.ops.object.select_all(action="DESELECT")
    ob = bpy.data.objects[name]
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    return ob


def edit_bmesh():
    ob = bpy.context.active_object
    bpy.ops.object.mode_set(mode="EDIT")
    me = ob.data
    bm = bmesh.from_edit_mesh(me)
    return ob, me, bm


def sync(bm, me):
    """Commit bmesh edits back to the mesh so hashing sees them."""
    bmesh.update_edit_mesh(me)


def mesh_status():
    """Painless metric: total mesh verts/polys across scene meshes."""
    nv = np = 0
    for ob in bpy.data.objects:
        if ob.type == "MESH":
            nv += len(ob.data.vertices)
            np += len(ob.data.polygons)
    return {"verts": nv, "polys": np}


# ---------------------------------------------------------------- ops -------

def op_reset_scene(_p):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def op_create_meshes(_p):
    bpy.ops.mesh.primitive_cube_add(size=2)
    bpy.context.active_object.name = "MeshA"
    bpy.ops.mesh.primitive_cylinder_add(radius=1, depth=2, vertices=24)
    bpy.context.active_object.name = "MeshB"
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=32, ring_count=16)
    bpy.context.active_object.name = "MeshC"


def op_obj_select_a(_p):
    select_only("MeshA")


def op_obj_translate_a(_p):
    bpy.ops.transform.translate(value=(1.0, 0.0, 0.0))


def op_obj_rotate_a(_p):
    ob = bpy.context.active_object
    ob.rotation_euler.z += 0.5


def op_obj_scale_a(_p):
    ob = bpy.context.active_object
    ob.scale = (1.2, 1.2, 1.2)


def op_obj_apply_a(_p):
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def op_enter_edit_a(_p):
    select_only("MeshA")
    bpy.ops.object.mode_set(mode="EDIT")


def op_edit_select_all(_p):
    bpy.ops.mesh.select_all(action="SELECT")


def op_edit_extrude(p):
    ob, me, bm = edit_bmesh()
    faces = [f for f in bm.faces if f.select]
    res = bmesh.ops.extrude_face_region(bm, geom=faces)
    new_verts = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
    d = p.get("distance", 0.3)
    for v in new_verts:
        v.co.z += d
    sync(bm, me)


def op_edit_inset(p):
    ob, me, bm = edit_bmesh()
    faces = [f for f in bm.faces if f.select]
    bmesh.ops.inset_region(
        bm,
        faces=faces,
        thickness=p.get("thickness", 0.2),
        depth=0.05,
        use_even_offset=True,
    )
    sync(bm, me)


def op_edit_bevel(p):
    ob, me, bm = edit_bmesh()
    edges = [e for e in bm.edges if e.select]
    bmesh.ops.bevel(bm, geom=edges, offset=p.get("offset", 0.1), segments=1)
    sync(bm, me)


def op_edit_loop_cut(p):
    ob, me, bm = edit_bmesh()
    z = p.get("z", 0.5)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(
        bm,
        geom=geom,
        plane_co=(0.0, 0.0, z),
        plane_no=(0.0, 0.0, 1.0),
        dist=1e-4,
        clear_inner=False,
        clear_outer=False,
    )
    sync(bm, me)


def op_edit_merge_doubles(p):
    ob, me, bm = edit_bmesh()
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=p.get("distance", 0.001))
    sync(bm, me)


def op_edit_dissolve_edges(_p):
    ob, me, bm = edit_bmesh()
    # Deterministic subset: dissolve edges whose midpoint is in the lower half
    # (y < -0.5) — a geometric criterion stable across runs.
    target = [e for e in bm.edges if e.verts[0].co.y < -0.5 and e.verts[1].co.y < -0.5]
    bmesh.ops.dissolve_edges(bm, edges=target, use_verts=True)
    sync(bm, me)


def op_edit_recalc_normals(_p):
    ob, me, bm = edit_bmesh()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    sync(bm, me)


def op_edit_select_subset(p):
    ob, me, bm = edit_bmesh()
    bpy.ops.mesh.select_all(action="DESELECT")
    zmin = p.get("z_min", 0.1)
    for v in bm.verts:
        if v.co.z >= zmin:
            v.select = True
    sync(bm, me)


def op_edit_delete_verts(_p):
    ob, me, bm = edit_bmesh()
    sel = [v for v in bm.verts if v.select]
    bmesh.ops.delete(bm, geom=sel, context="VERTS")
    sync(bm, me)


def op_edit_transform_selected(p):
    ob, me, bm = edit_bmesh()
    # Deletion clears selection; re-select all so the transform is non-degenerate.
    bpy.ops.mesh.select_all(action="SELECT")
    dx = p.get("dx", 0.3)
    for v in bm.verts:
        v.co.x += dx
    sync(bm, me)


def op_exit_edit_a(_p):
    bpy.ops.object.mode_set(mode="OBJECT")


def op_obj_duplicate_c(_p):
    select_only("MeshC")
    bpy.ops.object.duplicate_move()


def op_obj_join_cc(_p):
    # Join MeshC + MeshC.001 (dup becomes active when duplicated).
    bpy.ops.object.select_all(action="DESELECT")
    bpy.data.objects["MeshC.001"].select_set(True)
    bpy.data.objects["MeshC"].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects["MeshC"]
    bpy.ops.object.join()


def op_obj_scale_b(_p):
    select_only("MeshB")
    ob = bpy.context.active_object
    ob.scale = (1.3, 1.3, 1.3)


def op_final_snapshot(_p):
    pass


OPS = {
    "reset_scene": op_reset_scene,
    "create_meshes": op_create_meshes,
    "obj_select_a": op_obj_select_a,
    "obj_translate_a": op_obj_translate_a,
    "obj_rotate_a": op_obj_rotate_a,
    "obj_scale_a": op_obj_scale_a,
    "obj_apply_a": op_obj_apply_a,
    "enter_edit_a": op_enter_edit_a,
    "edit_select_all": op_edit_select_all,
    "edit_extrude": op_edit_extrude,
    "edit_inset": op_edit_inset,
    "edit_bevel": op_edit_bevel,
    "edit_loop_cut": op_edit_loop_cut,
    "edit_merge_doubles": op_edit_merge_doubles,
    "edit_dissolve_edges": op_edit_dissolve_edges,
    "edit_recalc_normals": op_edit_recalc_normals,
    "edit_select_subset": op_edit_select_subset,
    "edit_delete_verts": op_edit_delete_verts,
    "edit_transform_selected": op_edit_transform_selected,
    "exit_edit_a": op_exit_edit_a,
    "obj_duplicate_c": op_obj_duplicate_c,
    "obj_join_cc": op_obj_join_cc,
    "obj_scale_b": op_obj_scale_b,
    "final_snapshot": op_final_snapshot,
}


def main():
    if not CONTROL or not OUT:
        print("CORPUS_WORKER missing control/out env", file=sys.stderr)
        sys.exit(2)

    with open(CONTROL) as f:
        control = json.load(f)
    ops = control["ops"]

    results = []
    version = bpy.app.version_string
    try:
        for op in ops:
            heartbeat()
            op_id = op["id"]
            params = {k: v for k, v in op.items() if k != "id"}
            fn = OPS.get(op_id)
            if fn is None:
                results.append({"op": op_id, "error": "unknown op"})
                continue
            fn(params)
            st = mesh_status()
            results.append(
                {
                    "op": op_id,
                    "hash": canonical_hash(),
                    "sel": selection_snapshot(),
                    "verts": st["verts"],
                    "polys": st["polys"],
                }
            )
        status = "PASS"
    except Exception as e:  # noqa: BLE001 — record & exit, runner decides
        import traceback

        results.append({"op": op_id if "op_id" in dir() else "?", "error": repr(e)})
        heartbeat()
        status = "ERROR"

    out = {
        "status": status,
        "blender_version": version,
        "results": results,
        "final_hash": results[-1]["hash"] if results and "hash" in results[-1] else None,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2)
    print("CORPUS_WORKER status=%s ops=%d" % (status, len(ops)), file=sys.stderr)
    sys.exit(0 if status == "PASS" else 1)


if __name__ == "__main__":
    main()
