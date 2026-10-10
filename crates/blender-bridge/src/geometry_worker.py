import bmesh
import json
import math
import os
import sys
import threading
import time

import bpy
from mathutils import Euler, Matrix, Vector

INPUT_PATH, OUTPUT_PATH = sys.argv[-2:]
MAX_VERTICES = 250000
MAX_TRIANGLES = 500000
MAX_OUTPUT_BYTES = 128 * 1024 * 1024
HEARTBEAT = os.environ.get("BLENDER_BRIDGE_HEARTBEAT", "")
stop_heartbeat = threading.Event()


def heartbeat_loop():
    while not stop_heartbeat.wait(0.4):
        if HEARTBEAT:
            try:
                with open(HEARTBEAT, "a", encoding="utf-8") as stream:
                    stream.write(".")
            except OSError:
                pass


threading.Thread(target=heartbeat_loop, daemon=True).start()


def fail(message):
    raise RuntimeError(message)


def create_object(name, source, apply_transform=True):
    positions = source["positions"]
    indices = source["indices"]
    if len(positions) // 3 > MAX_VERTICES or len(indices) // 3 > MAX_TRIANGLES:
        fail("input geometry limit exceeded")
    vertices = [tuple(positions[i:i + 3]) for i in range(0, len(positions), 3)]
    faces = [tuple(indices[i:i + 3]) for i in range(0, len(indices), 3)]
    mesh = bpy.data.meshes.new(name + "-mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if apply_transform:
        tx, ty, tz, rx, ry, rz, sx, sy, sz = source["transform"]
        obj.matrix_world = Matrix.LocRotScale(
            Vector((tx, ty, tz)),
            Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ"),
            Vector((sx, sy, sz)),
        )
    return obj


def select_active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def repair_mesh(obj):
    mesh = obj.data
    diagonal = (obj.dimensions.length if obj.dimensions.length > 0 else 1.0)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=max(diagonal * 1e-7, 1e-8))
    bmesh.ops.dissolve_degenerate(bm, edges=list(bm.edges), dist=max(diagonal * 1e-8, 1e-9))
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    if boundary:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    return obj


def apply_boolean(left, right, operation):
    select_active(left)
    modifier = left.modifiers.new(name="trusted-geometry-boolean", type="BOOLEAN")
    modifier.operation = {
        "boolean_union": "UNION",
        "boolean_subtract": "DIFFERENCE",
        "boolean_intersect": "INTERSECT",
    }[operation]
    modifier.solver = "EXACT"
    modifier.object = right
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(right, do_unlink=True)
    left.data.update()
    return left


def serialize_mesh(obj, bake_world=False):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.triangulate(bm, faces=list(bm.faces))
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    positions = [
        coordinate
        for vertex in bm.verts
        for coordinate in ((obj.matrix_world @ vertex.co) if bake_world else vertex.co)
    ]
    triangles = [list(face.verts[corner].index for corner in range(3)) for face in bm.faces]
    if len(positions) // 3 > MAX_VERTICES or len(triangles) > MAX_TRIANGLES:
        fail("output geometry limit exceeded")
    volume = 0.0
    for a, b, c in triangles:
        pa = Vector(positions[a * 3:a * 3 + 3])
        pb = Vector(positions[b * 3:b * 3 + 3])
        pc = Vector(positions[c * 3:c * 3 + 3])
        volume += pa.dot(pb.cross(pc)) / 6.0
    output = {
        "positions": positions,
        "triangles": triangles,
        "watertight": all(not edge.is_boundary and not edge.is_wire for edge in bm.edges),
        "volume_mm3": abs(volume),
    }
    bm.free()
    bpy.data.meshes.remove(mesh)
    return output


def main():
    with open(INPUT_PATH, "r", encoding="utf-8") as stream:
        request = json.load(stream)
    operation = request["operation"]
    operands = request["inputs"]
    if operation == "repair" and len(operands) == 1:
        result = repair_mesh(create_object("repair-input", operands[0], apply_transform=False))
    elif operation in ("boolean_union", "boolean_subtract", "boolean_intersect") and len(operands) == 2:
        left = create_object("boolean-left", operands[0])
        right = create_object("boolean-right", operands[1])
        result = apply_boolean(left, right, operation)
    else:
        fail("unsupported operation or operand count")
    artifact = serialize_mesh(result, bake_world=operation != "repair")
    encoded = json.dumps(artifact, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_OUTPUT_BYTES:
        fail("output artifact byte limit exceeded")
    with open(OUTPUT_PATH, "wb") as stream:
        stream.write(encoded)


try:
    main()
except Exception as error:
    failure = json.dumps({"error": str(error)[:2048]}, separators=(",", ":")).encode("utf-8")
    if len(failure) <= MAX_OUTPUT_BYTES:
        with open(OUTPUT_PATH, "wb") as stream:
            stream.write(failure)
    raise
finally:
    stop_heartbeat.set()
