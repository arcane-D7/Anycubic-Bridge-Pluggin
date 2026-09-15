const fs = require("node:fs");

// Read project settings extracted from the recovery 3MF
const src = fs.readFileSync(
  "<EXPORT_ROOT>\\csh-3mf\\Metadata_project_settings.config",
  "utf8",
);
const proj = JSON.parse(src);

// Machine preset: only the keys the engine needs for a valid slice.
// CRITICAL: klipper + use_relative_e_distances=1 requires layer_gcode "G92 E0"
const pick = (src2, keys) => {
  const out = {};
  for (const k of keys) if (k in src2) out[k] = src2[k];
  return out;
};

const machine = {
  type: "machine_model",
  machine_tech: "FFF",
  family: "Kobra S1",
  name: proj.printer_model ?? "Anycubic Kobra S1",
  model_id: proj.printer_model ?? "Anycubic Kobra S1",
  printer_settings_id: proj.printer_settings_id ?? "Anycubic Kobra S1 0.4 nozzle",
  ...pick(proj, [
    "nozzle_diameter",
    "printable_area",
    "printable_height",
    "gcode_flavor",
    "use_relative_e_distances",
    "before_layer_change_gcode",
    "layer_change_gcode",
    "machine_start_gcode",
    "machine_end_gcode",
    "machine_pause_gcode",
    "machine_max_acceleration_e",
    "machine_max_acceleration_extruding",
    "machine_max_acceleration_retracting",
    "machine_max_acceleration_travel",
    "machine_max_acceleration_x",
    "machine_max_acceleration_y",
    "machine_max_acceleration_z",
    "machine_max_jerk_e",
    "machine_max_jerk_x",
    "machine_max_jerk_y",
    "machine_max_jerk_z",
    "machine_max_speed_e",
    "machine_max_speed_x",
    "machine_max_speed_y",
    "machine_max_speed_z",
    "machine_min_extruding_rate",
    "machine_min_travel_rate",
    "thumbnails",
    "thumbnails_format",
    "thumbnails_internal",
    "thumbnails_internal_switch",
    "print_sequence",
    "print_order",
    "first_layer_print_sequence",
    "other_layers_print_sequence",
    "other_layers_print_sequence_nums",
    "emit_machine_limits_to_gcode",
    "extruder_colour",
    "manual_filament_change",
    "silent_mode",
    "host_type",
    "nozzle_type",
    "nozzle_volume",
    "retraction_length",
    "retraction_speed",
    "retract_when_changing_layer",
    "z_hop",
    "wipe",
    "scan_first_layer",
    "machine_load_filament_time",
    "max_layer_height",
    "min_layer_height",
    "printer_structure",
  ]),
  // The critical fix
  layer_gcode: "G92 E0",
  // Ensure compatible printers condition uses this profile
  compatible_printers_condition: `printer_model=="${proj.printer_model ?? "Anycubic Kobra S1"}" and nozzle_diameter[0]=="${proj.nozzle_diameter ?? "0.4"}"`,
};

// Process settings from project
const processKeys = [
  "layer_height",
  "initial_layer_print_height",
  "line_width",
  "initial_layer_line_width",
  "outer_wall_line_width",
  "inner_wall_line_width",
  "top_surface_line_width",
  "sparse_infill_line_width",
  "internal_solid_infill_line_width",
  "top_shell_layers",
  "top_shell_thickness",
  "bottom_shell_layers",
  "bottom_shell_thickness",
  "wall_loops",
  "sparse_infill_density",
  "infill_pattern",
  "print_flow_ratio",
  "wall_speed",
  "sparse_infill_speed",
  "internal_solid_infill_speed",
  "top_surface_speed",
  "outer_wall_speed",
  "inner_wall_speed",
  "travel_speed",
  "initial_layer_speed",
  "initial_layer_infill_speed",
  "initial_layer_travel_speed",
  "fuzzy_skin",
  "enable_support",
  "support_type",
  "support_threshold_angle",
  "support_on_build_plate_only",
  "support_interface_*",
  "support_style",
  "support_base_pattern",
  "brim_type",
  "brim_width",
  "skirt_loops",
  "skirt_distance",
  "filament_type",
  "enable_arc_fitting",
  "seam_position",
  "spiral_mode",
  "ironing_type",
  "ironing_flow",
  "ironing_speed",
  "max_volumetric_extrusion_rate_slope",
].filter((k) => !k.endsWith("*"));
const process = {
  type: "process",
  name: proj.default_print_profile ?? "recovery 0.20mm Standard @Anycubic Kobra S1 0.4 nozzle",
  print_settings_id: proj.default_print_profile ?? "recovery",
  ...pick(proj, processKeys),
};

const filament = {
  type: "filament",
  name: proj.default_filament_profile ?? "Anycubic PLA @Anycubic Kobra S1 0.4 nozzle",
  filament_settings_id: "recovery-pla",
  ...pick(proj, [
    "filament_type",
    "hot_plate_temp",
    "hot_plate_temp_initial_layer",
    "nozzle_temperature",
    "nozzle_temperature_initial_layer",
    "filament_start_gcode",
    "filament_end_gcode",
    "filament_retraction_length",
    "filament_retraction_speed",
    "filament_retract_lift",
    "filament_flow_ratio",
    "filament_density",
    "filament_cost",
    "filament_vendor",
    "filament_colour",
    "filament_max_volumetric_speed",
    "fan_speed",
    "initial_layer_min_bead_width",
    "filament_deretraction_speed",
    "filament_retraction_speed",
    "filament_retract_before_wipe",
    "filament_retract_restart_extra",
    "filament_retract_when_changing_layer",
    "filament_wipe",
  ]),
};

const out =
  "<EXPORT_ROOT>\\csh-3mf\\recovery-settings.json";
fs.writeFileSync(out, JSON.stringify({ machine, process, filament }, null, 2));
console.log("written:", out);
console.log("machine keys:", Object.keys(machine).length);
console.log("process keys:", Object.keys(process).length);
console.log("filament keys:", Object.keys(filament).length);
