# Shelf recovery: verified Cloud telemetry

Update: see `mcp-recovery-data-contract.md` for subsequent HTTP ID corrections,
validated file inventory, expanded MCP tool, user-confirmed layer completion,
and the official USB log/configuration export route. Recovery remains open.

## Read-only experiment

Run `node local-scripts/experiments/recovery-position-readonly.mjs`. This publishes only the
known query operations over authenticated Cloud MQTT. It does not start a
print, home axes, move, extrude, or change temperatures.

Two separate axis replies returned code 200 and identical coordinates:

```json
{ "x": 47, "y": 276, "z": 4.034207620182453 }
```

The second printer timestamp was 1789075476602. These are current reported
coordinates, not a recovered crash position or proof of a valid homing reference.

`info/query` returned `project: null`, `state: free`, and last project
0 with `state: failed`, `pause: 0`, `curr_layer: 62`,
`total_layers: 150`, `progress: 53`. Filename:
`0910-2020-OpenSCAD Model_plate(01)_PLA_0.2_2h32m25s.gcode`.
Firmware: <FW_VERSION>.

Axis, peripherals, identity, temperature, AI settings and ACE information
responded. `print/query` and `extfilbox/query` had no reply within 20 seconds;
that is a timeout observation, not proof that these capabilities never exist.

## Integration finding

HTTP sendOrder acceptance must not be reported as a successful diagnostic
read. Subsequent testing established that the earlier HTTP attempt used an
incorrect ID: axis query is 1214, not 1219. The corrected HTTP query also
produced an axis report. Both transport paths now have live evidence.

## Recovery gate

The reported Z of 4.034207620182453 does not match the nominal 12.4 mm for
layer 62 at 0.2 mm. No homed-state, coordinate offsets, executed G-code byte
offset or exact last completed extrusion was returned by these queries.
Do not infer a safe resume from the precision of the coordinate number or
from `curr_layer` alone. A failed task is not a paused task.

The user confirms the printed part remains fixed to the bed. Axis movement,
reboot history and coordinate-reference validity still need establishing
before generating an executable in-place restart. No recovery print was started.
