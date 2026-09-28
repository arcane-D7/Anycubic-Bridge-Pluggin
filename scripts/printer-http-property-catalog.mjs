/**
 * HTTP property catalog — GENERATED, do not hand-edit.
 *
 * Produced by scripts/gen-http-property-catalog.mjs from the live captures in
 * docs/evidence (real Kobra S1 <PRINTER_ID>, firmware <FW_VERSION>). Regenerate after any
 * capture that adds or changes endpoint fields:
 *
 *   node scripts/gen-http-property-catalog.mjs
 */
export const HTTP_PROPERTY_CATALOG = Object.freeze({
  printer_status: {
    path: "/v2/Printer/status",
    evidence: "live",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.device_status",
        group: "general",
      },
      {
        path: "data.id",
        group: "identity",
      },
      {
        path: "data.is_printing",
        group: "general",
      },
      {
        path: "data.key",
        group: "identity",
      },
      {
        path: "data.machine_type",
        group: "identity",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  printer_info: {
    path: "/v2/printer/info",
    evidence: "live",
    note: "richest single source: 128 fields",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.advance",
        group: "general",
      },
      {
        path: "data.base",
        group: "general",
      },
      {
        path: "data.base.create_time",
        group: "print",
      },
      {
        path: "data.base.description",
        group: "identity",
      },
      {
        path: "data.base.firmware_version",
        group: "identity",
      },
      {
        path: "data.base.machine_mac",
        group: "identity",
      },
      {
        path: "data.base.material_type",
        group: "material",
      },
      {
        path: "data.base.material_used",
        group: "material",
      },
      {
        path: "data.base.print_count",
        group: "identity",
      },
      {
        path: "data.base.print_totaltime",
        group: "print",
        unit: "second",
      },
      {
        path: "data.device_status",
        group: "general",
      },
      {
        path: "data.external_shelves",
        group: "general",
      },
      {
        path: "data.external_shelves.brand_name",
        group: "identity",
      },
      {
        path: "data.external_shelves.color",
        group: "material",
      },
      {
        path: "data.external_shelves.current_status",
        group: "general",
      },
      {
        path: "data.external_shelves.id",
        group: "identity",
      },
      {
        path: "data.external_shelves.loaded",
        group: "general",
      },
      {
        path: "data.external_shelves.material_name",
        group: "material",
      },
      {
        path: "data.external_shelves.status_type",
        group: "general",
      },
      {
        path: "data.external_shelves.type",
        group: "general",
      },
      {
        path: "data.features",
        group: "capability",
      },
      {
        path: "data.features[].name",
        group: "capability",
      },
      {
        path: "data.features[].value",
        group: "capability",
      },
      {
        path: "data.free_temp_limit",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.head_tools_model",
        group: "capability",
      },
      {
        path: "data.help_url",
        group: "general",
      },
      {
        path: "data.id",
        group: "identity",
      },
      {
        path: "data.img",
        group: "identity",
      },
      {
        path: "data.is_printing",
        group: "general",
      },
      {
        path: "data.is_read_quick_start_url",
        group: "general",
      },
      {
        path: "data.key",
        group: "identity",
      },
      {
        path: "data.machine_data",
        group: "identity",
      },
      {
        path: "data.machine_data.anti_max",
        group: "identity",
      },
      {
        path: "data.machine_data.format",
        group: "identity",
      },
      {
        path: "data.machine_data.name",
        group: "identity",
      },
      {
        path: "data.machine_data.pixel",
        group: "identity",
      },
      {
        path: "data.machine_data.res_x",
        group: "identity",
      },
      {
        path: "data.machine_data.res_y",
        group: "identity",
      },
      {
        path: "data.machine_data.size_x",
        group: "identity",
      },
      {
        path: "data.machine_data.size_y",
        group: "identity",
      },
      {
        path: "data.machine_data.size_z",
        group: "identity",
      },
      {
        path: "data.machine_data.suffix",
        group: "identity",
      },
      {
        path: "data.machine_type",
        group: "identity",
      },
      {
        path: "data.maintenance_manual_url",
        group: "general",
      },
      {
        path: "data.max_box_num",
        group: "ace",
      },
      {
        path: "data.model",
        group: "identity",
      },
      {
        path: "data.multi_color_box",
        group: "material",
      },
      {
        path: "data.multi_color_box.auto_feed",
        group: "material",
      },
      {
        path: "data.multi_color_box.curr_nozzle_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.multi_color_box.drying_status",
        group: "material",
      },
      {
        path: "data.multi_color_box.drying_status.duration",
        group: "material",
      },
      {
        path: "data.multi_color_box.drying_status.remain_time",
        group: "material",
        unit: "second",
      },
      {
        path: "data.multi_color_box.drying_status.status",
        group: "material",
      },
      {
        path: "data.multi_color_box.drying_status.target_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.multi_color_box.feed_status",
        group: "material",
      },
      {
        path: "data.multi_color_box.feed_status.code",
        group: "material",
      },
      {
        path: "data.multi_color_box.feed_status.current_status",
        group: "material",
      },
      {
        path: "data.multi_color_box.feed_status.slot_index",
        group: "material",
      },
      {
        path: "data.multi_color_box.feed_status.type",
        group: "material",
      },
      {
        path: "data.multi_color_box.humidity",
        group: "material",
      },
      {
        path: "data.multi_color_box.id",
        group: "material",
      },
      {
        path: "data.multi_color_box.loaded_slot",
        group: "material",
      },
      {
        path: "data.multi_color_box.model_id",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].color",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].color_group",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].consumables_percent",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].edit_status",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].icon_type",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].index",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].sku",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].status",
        group: "material",
      },
      {
        path: "data.multi_color_box.slots[].type",
        group: "material",
      },
      {
        path: "data.multi_color_box.status",
        group: "material",
      },
      {
        path: "data.multi_color_box.target_nozzle_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.multi_color_box.temp",
        group: "temperature",
      },
      {
        path: "data.multi_color_box_version",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].box_id",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].box_name",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].firmware_version",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].force_update",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].img",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].need_update",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].target_version",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].time_cost",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].update_date",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].update_desc",
        group: "material",
      },
      {
        path: "data.multi_color_box_version[].update_progress",
        group: "material",
        unit: "percent",
      },
      {
        path: "data.multi_color_box_version[].update_status",
        group: "material",
      },
      {
        path: "data.name",
        group: "identity",
      },
      {
        path: "data.need_update",
        group: "general",
      },
      {
        path: "data.nozzle_diameter",
        group: "identity",
      },
      {
        path: "data.parameter",
        group: "general",
      },
      {
        path: "data.parameter.curr_hotbed_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.parameter.curr_nozzle_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.quick_start_url",
        group: "general",
      },
      {
        path: "data.releasefilm_url",
        group: "general",
      },
      {
        path: "data.rotate_deg",
        group: "general",
      },
      {
        path: "data.temp_limit",
        group: "temperature",
      },
      {
        path: "data.tools",
        group: "capability",
      },
      {
        path: "data.tools[].control",
        group: "capability",
      },
      {
        path: "data.tools[].function_des",
        group: "capability",
      },
      {
        path: "data.tools[].function_name",
        group: "capability",
      },
      {
        path: "data.tools[].function_type",
        group: "capability",
      },
      {
        path: "data.tools[].icon_url",
        group: "capability",
      },
      {
        path: "data.tools[].id",
        group: "capability",
      },
      {
        path: "data.tools[].model_id",
        group: "capability",
      },
      {
        path: "data.tools[].param",
        group: "capability",
      },
      {
        path: "data.tools[].parent_id",
        group: "capability",
      },
      {
        path: "data.tools[].show_place",
        group: "ace",
      },
      {
        path: "data.tools[].status",
        group: "capability",
      },
      {
        path: "data.tools[].typd_id",
        group: "capability",
      },
      {
        path: "data.tools[].type_function_id",
        group: "capability",
      },
      {
        path: "data.type_function_ids",
        group: "capability",
      },
      {
        path: "data.version",
        group: "identity",
      },
      {
        path: "data.version.firmware_version",
        group: "identity",
      },
      {
        path: "data.version.force_update",
        group: "identity",
      },
      {
        path: "data.version.img",
        group: "identity",
      },
      {
        path: "data.version.need_update",
        group: "identity",
      },
      {
        path: "data.version.target_version",
        group: "identity",
      },
      {
        path: "data.version.time_cost",
        group: "print",
      },
      {
        path: "data.version.update_date",
        group: "identity",
      },
      {
        path: "data.version.update_desc",
        group: "identity",
      },
      {
        path: "data.version.update_progress",
        group: "print",
        unit: "percent",
      },
      {
        path: "data.version.update_status",
        group: "identity",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  printer_functions: {
    path: "/v2/printer/functions",
    evidence: "live",
    note: "returned Photon S metadata for Kobra S1 inputs — not a reliable capability list",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.name",
        group: "identity",
      },
      {
        path: "data.net_function_ids",
        group: "capability",
      },
      {
        path: "data.type_function_ids",
        group: "capability",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  project_info: {
    path: "/v2/project/info",
    evidence: "live",
    note: "126 fields incl. slice_param/slice_result and device_message",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.auto_operation",
        group: "general",
      },
      {
        path: "data.aux_fan_speed_limit",
        group: "cooling",
      },
      {
        path: "data.aux_fan_speed_pct",
        group: "cooling",
      },
      {
        path: "data.box_fan_level",
        group: "cooling",
      },
      {
        path: "data.box_fan_level_limit",
        group: "cooling",
      },
      {
        path: "data.create_time",
        group: "print",
      },
      {
        path: "data.device_message",
        group: "general",
      },
      {
        path: "data.device_message.action",
        group: "general",
      },
      {
        path: "data.device_message.curr_layer",
        group: "print",
      },
      {
        path: "data.device_message.display_filename",
        group: "identity",
      },
      {
        path: "data.device_message.filename",
        group: "identity",
      },
      {
        path: "data.device_message.heating_remain_time",
        group: "print",
        unit: "second",
      },
      {
        path: "data.device_message.localtask",
        group: "print",
      },
      {
        path: "data.device_message.origin3mf",
        group: "general",
      },
      {
        path: "data.device_message.print_time",
        group: "print",
        unit: "second",
      },
      {
        path: "data.device_message.progress",
        group: "print",
        unit: "percent",
      },
      {
        path: "data.device_message.reason",
        group: "print",
      },
      {
        path: "data.device_message.remain_time",
        group: "print",
        unit: "second",
      },
      {
        path: "data.device_message.resume_needs_unpack",
        group: "general",
      },
      {
        path: "data.device_message.slicer",
        group: "general",
      },
      {
        path: "data.device_message.source_type",
        group: "general",
      },
      {
        path: "data.device_message.state",
        group: "print",
      },
      {
        path: "data.device_message.supplies_usage",
        group: "material",
      },
      {
        path: "data.device_message.taskid",
        group: "print",
      },
      {
        path: "data.device_message.temp_dir",
        group: "temperature",
      },
      {
        path: "data.device_message.temp_gcode",
        group: "temperature",
      },
      {
        path: "data.device_message.timestamp",
        group: "print",
      },
      {
        path: "data.device_message.total_layers",
        group: "print",
      },
      {
        path: "data.end_time",
        group: "print",
      },
      {
        path: "data.fan_limit",
        group: "cooling",
      },
      {
        path: "data.fan_speed_pct",
        group: "cooling",
      },
      {
        path: "data.gcode_id",
        group: "identity",
      },
      {
        path: "data.gcode_name",
        group: "identity",
      },
      {
        path: "data.id",
        group: "identity",
      },
      {
        path: "data.img",
        group: "identity",
      },
      {
        path: "data.is_comment",
        group: "general",
      },
      {
        path: "data.is_feedback",
        group: "general",
      },
      {
        path: "data.key",
        group: "identity",
      },
      {
        path: "data.machine_name",
        group: "identity",
      },
      {
        path: "data.machine_type",
        group: "identity",
      },
      {
        path: "data.material",
        group: "material",
      },
      {
        path: "data.material_unit",
        group: "material",
      },
      {
        path: "data.model",
        group: "identity",
      },
      {
        path: "data.monitor",
        group: "general",
      },
      {
        path: "data.pause",
        group: "print",
      },
      {
        path: "data.post_id",
        group: "identity",
      },
      {
        path: "data.post_title",
        group: "general",
      },
      {
        path: "data.print_speed_mode",
        group: "general",
      },
      {
        path: "data.print_speed_model_des",
        group: "identity",
      },
      {
        path: "data.print_speed_model_des[].print_speed_mode",
        group: "identity",
      },
      {
        path: "data.print_speed_model_des[].title",
        group: "identity",
      },
      {
        path: "data.print_speed_pct",
        group: "general",
      },
      {
        path: "data.print_status",
        group: "print",
      },
      {
        path: "data.printer_monitor",
        group: "identity",
      },
      {
        path: "data.printer_name",
        group: "identity",
      },
      {
        path: "data.printer_type",
        group: "identity",
      },
      {
        path: "data.progress",
        group: "print",
        unit: "percent",
      },
      {
        path: "data.project_type",
        group: "general",
      },
      {
        path: "data.reason",
        group: "print",
      },
      {
        path: "data.reason_help_url",
        group: "print",
      },
      {
        path: "data.reason_id",
        group: "print",
      },
      {
        path: "data.rotate_deg",
        group: "general",
      },
      {
        path: "data.set_limit",
        group: "general",
      },
      {
        path: "data.slice_param",
        group: "slice",
      },
      {
        path: "data.slice_param.bed_temperature",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.slice_param.brim_type",
        group: "slice",
      },
      {
        path: "data.slice_param.filament_retract_length",
        group: "material",
      },
      {
        path: "data.slice_param.filament_type",
        group: "material",
      },
      {
        path: "data.slice_param.fill_density",
        group: "slice",
        unit: "percent",
      },
      {
        path: "data.slice_param.layer_height",
        group: "print",
      },
      {
        path: "data.slice_param.material_name",
        group: "material",
      },
      {
        path: "data.slice_param.paint_infos",
        group: "material",
      },
      {
        path: "data.slice_param.paint_infos[].filament_used",
        group: "material",
        unit: "mixed",
      },
      {
        path: "data.slice_param.paint_infos[].material_type",
        group: "material",
      },
      {
        path: "data.slice_param.paint_infos[].paint_color",
        group: "material",
      },
      {
        path: "data.slice_param.paint_infos[].paint_index",
        group: "material",
      },
      {
        path: "data.slice_param.perimeter_extrusion_width",
        group: "slice",
      },
      {
        path: "data.slice_param.perimeter_speed",
        group: "slice",
      },
      {
        path: "data.slice_param.perimeters",
        group: "slice",
      },
      {
        path: "data.slice_param.printer_settings_id",
        group: "slice",
      },
      {
        path: "data.slice_param.support_material_auto",
        group: "material",
      },
      {
        path: "data.slice_param.temperature",
        group: "temperature",
      },
      {
        path: "data.slice_param.travel_speed",
        group: "slice",
      },
      {
        path: "data.slice_result",
        group: "slice",
      },
      {
        path: "data.slice_result.size_x",
        group: "slice",
      },
      {
        path: "data.slice_result.size_y",
        group: "slice",
      },
      {
        path: "data.slice_result.size_z",
        group: "slice",
      },
      {
        path: "data.slice_status",
        group: "general",
      },
      {
        path: "data.sliced_plates",
        group: "general",
      },
      {
        path: "data.task_mode",
        group: "print",
      },
      {
        path: "data.task_settings",
        group: "print",
      },
      {
        path: "data.task_settings.ai_detect",
        group: "print",
      },
      {
        path: "data.task_settings.ai_settings",
        group: "print",
      },
      {
        path: "data.task_settings.ai_settings.count",
        group: "print",
      },
      {
        path: "data.task_settings.ai_settings.notice_type",
        group: "print",
      },
      {
        path: "data.task_settings.ai_settings.sensitivity_level",
        group: "print",
      },
      {
        path: "data.task_settings.ai_settings.status",
        group: "print",
      },
      {
        path: "data.task_settings.ai_settings.type",
        group: "print",
      },
      {
        path: "data.task_settings.auto_leveling",
        group: "print",
      },
      {
        path: "data.task_settings.camera_timelapse",
        group: "print",
      },
      {
        path: "data.task_settings.dry_mode",
        group: "print",
      },
      {
        path: "data.task_settings.drying_settings",
        group: "print",
      },
      {
        path: "data.task_settings.drying_settings.dry_remain_time",
        group: "print",
        unit: "second",
      },
      {
        path: "data.task_settings.drying_settings.duration",
        group: "print",
      },
      {
        path: "data.task_settings.drying_settings.target_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.task_settings.flow_calibration",
        group: "print",
      },
      {
        path: "data.task_settings.timelapse",
        group: "print",
      },
      {
        path: "data.task_settings.timelapse.mode",
        group: "print",
      },
      {
        path: "data.task_settings.timelapse.status",
        group: "print",
      },
      {
        path: "data.task_settings.vibration_compensation",
        group: "print",
      },
      {
        path: "data.temp",
        group: "temperature",
      },
      {
        path: "data.temp.curr_chamber_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.temp.curr_hotbed_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.temp.curr_nozzle_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.temp.limit",
        group: "temperature",
      },
      {
        path: "data.temp.limit.hotbed_temp_limit",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.temp.limit.nozzle_temp_limit",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.temp.target_chamber_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.temp.target_hotbed_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.temp.target_nozzle_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.total_time",
        group: "print",
      },
      {
        path: "data.type_function_ids",
        group: "capability",
      },
      {
        path: "data.z_thick",
        group: "general",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  project_monitor: {
    path: "/v2/project/monitor",
    evidence: "live",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.monitor",
        group: "general",
      },
      {
        path: "data.monitor_des",
        group: "general",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  history_detail: {
    path: "/v5/project/printHistory/detail",
    evidence: "live",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.bed_type",
        group: "general",
      },
      {
        path: "data.end_time",
        group: "print",
      },
      {
        path: "data.estimated_time_s",
        group: "print",
        unit: "second",
      },
      {
        path: "data.estimated_time_str",
        group: "print",
        unit: "second",
      },
      {
        path: "data.file_name",
        group: "identity",
      },
      {
        path: "data.file_size",
        group: "general",
        unit: "mixed",
      },
      {
        path: "data.id",
        group: "identity",
      },
      {
        path: "data.is_comment",
        group: "general",
      },
      {
        path: "data.is_feedback",
        group: "general",
      },
      {
        path: "data.layer_count",
        group: "print",
      },
      {
        path: "data.model_dimensions",
        group: "identity",
      },
      {
        path: "data.model_dimensions.height",
        group: "identity",
      },
      {
        path: "data.model_dimensions.length",
        group: "identity",
      },
      {
        path: "data.model_dimensions.width",
        group: "identity",
      },
      {
        path: "data.nozzle_diameter",
        group: "identity",
      },
      {
        path: "data.nozzle_type",
        group: "identity",
      },
      {
        path: "data.paint_infos",
        group: "material",
      },
      {
        path: "data.paint_infos[].filament_used",
        group: "material",
        unit: "mixed",
      },
      {
        path: "data.paint_infos[].material_type",
        group: "material",
      },
      {
        path: "data.paint_infos[].paint_color",
        group: "material",
      },
      {
        path: "data.paint_infos[].paint_index",
        group: "material",
      },
      {
        path: "data.pause",
        group: "print",
      },
      {
        path: "data.print_params",
        group: "general",
      },
      {
        path: "data.print_params.bed_adhesion_type",
        group: "general",
      },
      {
        path: "data.print_params.bed_temperature",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.print_params.cooling_fan_speed",
        group: "cooling",
      },
      {
        path: "data.print_params.fill_density",
        group: "slice",
        unit: "percent",
      },
      {
        path: "data.print_params.layer_height",
        group: "print",
      },
      {
        path: "data.print_params.nozzle_temperature",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.print_params.perimeter_extrusion_width",
        group: "slice",
      },
      {
        path: "data.print_params.perimeter_speed_inner",
        group: "slice",
      },
      {
        path: "data.print_params.perimeter_speed_outer",
        group: "slice",
      },
      {
        path: "data.print_params.perimeters",
        group: "slice",
      },
      {
        path: "data.print_params.retraction_length",
        group: "general",
      },
      {
        path: "data.print_params.support_material_auto",
        group: "material",
      },
      {
        path: "data.print_params.travel_speed",
        group: "general",
      },
      {
        path: "data.print_status",
        group: "print",
      },
      {
        path: "data.print_time",
        group: "print",
        unit: "second",
      },
      {
        path: "data.printer_model",
        group: "identity",
      },
      {
        path: "data.printer_name",
        group: "identity",
      },
      {
        path: "data.progress",
        group: "print",
        unit: "percent",
      },
      {
        path: "data.reason",
        group: "print",
      },
      {
        path: "data.reason_id",
        group: "print",
      },
      {
        path: "data.start_time",
        group: "print",
      },
      {
        path: "data.thumbnail",
        group: "general",
      },
      {
        path: "data.total_filament_used",
        group: "material",
        unit: "mixed",
      },
      {
        path: "data.upload_time",
        group: "print",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  gcode_info_fdm: {
    path: "/work/gcode/infoFdm",
    evidence: "live",
    note: "resolves gcode_id -> cloud file id + slice metadata (63 fields)",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.create_time",
        group: "print",
      },
      {
        path: "data.estimate",
        group: "general",
      },
      {
        path: "data.file_id",
        group: "identity",
      },
      {
        path: "data.gcode_id",
        group: "identity",
      },
      {
        path: "data.image_id",
        group: "identity",
      },
      {
        path: "data.img",
        group: "identity",
      },
      {
        path: "data.machine_class",
        group: "identity",
      },
      {
        path: "data.material_unit",
        group: "material",
      },
      {
        path: "data.name",
        group: "identity",
      },
      {
        path: "data.progress",
        group: "print",
        unit: "percent",
      },
      {
        path: "data.size",
        group: "general",
        unit: "mixed",
      },
      {
        path: "data.slice_param",
        group: "slice",
      },
      {
        path: "data.slice_param.bed_temperature",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data.slice_param.brim_type",
        group: "slice",
      },
      {
        path: "data.slice_param.color_merge",
        group: "material",
      },
      {
        path: "data.slice_param.curr_bed_type",
        group: "slice",
      },
      {
        path: "data.slice_param.curr_bed_type_label",
        group: "slice",
      },
      {
        path: "data.slice_param.enable_support",
        group: "slice",
      },
      {
        path: "data.slice_param.extruder_colour",
        group: "slice",
      },
      {
        path: "data.slice_param.fan_max_speed",
        group: "cooling",
      },
      {
        path: "data.slice_param.fan_min_speed",
        group: "cooling",
      },
      {
        path: "data.slice_param.filament_retract_length",
        group: "material",
      },
      {
        path: "data.slice_param.filament_settings_id",
        group: "material",
      },
      {
        path: "data.slice_param.filament_type",
        group: "material",
      },
      {
        path: "data.slice_param.fill_density",
        group: "slice",
        unit: "percent",
      },
      {
        path: "data.slice_param.image_id",
        group: "slice",
      },
      {
        path: "data.slice_param.inner_wall_speed",
        group: "slice",
      },
      {
        path: "data.slice_param.layer_height",
        group: "print",
      },
      {
        path: "data.slice_param.nozzle_diameter",
        group: "slice",
      },
      {
        path: "data.slice_param.nozzle_type",
        group: "slice",
      },
      {
        path: "data.slice_param.nozzle_type_label",
        group: "slice",
      },
      {
        path: "data.slice_param.outer_wall_speed",
        group: "slice",
      },
      {
        path: "data.slice_param.paint_infos",
        group: "material",
      },
      {
        path: "data.slice_param.paint_infos[].filament_used",
        group: "material",
        unit: "mixed",
      },
      {
        path: "data.slice_param.paint_infos[].material_type",
        group: "material",
      },
      {
        path: "data.slice_param.paint_infos[].paint_color",
        group: "material",
      },
      {
        path: "data.slice_param.paint_infos[].paint_index",
        group: "material",
      },
      {
        path: "data.slice_param.perimeter_extrusion_width",
        group: "slice",
      },
      {
        path: "data.slice_param.perimeter_speed",
        group: "slice",
      },
      {
        path: "data.slice_param.perimeters",
        group: "slice",
      },
      {
        path: "data.slice_param.printer_model",
        group: "slice",
      },
      {
        path: "data.slice_param.printer_names",
        group: "slice",
      },
      {
        path: "data.slice_param.printer_settings_id",
        group: "slice",
      },
      {
        path: "data.slice_param.support_material_auto",
        group: "material",
      },
      {
        path: "data.slice_param.support_type",
        group: "slice",
      },
      {
        path: "data.slice_param.temperature",
        group: "temperature",
      },
      {
        path: "data.slice_param.travel_speed",
        group: "slice",
      },
      {
        path: "data.slice_result",
        group: "slice",
      },
      {
        path: "data.slice_result.bounding_box_max",
        group: "ace",
      },
      {
        path: "data.slice_result.bounding_box_min",
        group: "ace",
      },
      {
        path: "data.slice_result.filament used [g]",
        group: "material",
      },
      {
        path: "data.slice_result.model_size",
        group: "slice",
        unit: "mixed",
      },
      {
        path: "data.slice_result.print_time",
        group: "print",
        unit: "second",
      },
      {
        path: "data.slice_result.size_x",
        group: "slice",
      },
      {
        path: "data.slice_result.size_y",
        group: "slice",
      },
      {
        path: "data.slice_result.size_z",
        group: "slice",
      },
      {
        path: "data.slice_result.sliced_md5",
        group: "slice",
      },
      {
        path: "data.slice_result.total_layers",
        group: "print",
      },
      {
        path: "data.slice_result.used_filament",
        group: "material",
      },
      {
        path: "data.status",
        group: "general",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  printer_tool: {
    path: "/v2/printer/tool",
    evidence: "live",
    note: "type_function_id must be positive (13 = XYZ tool)",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data.default_tip",
        group: "general",
      },
      {
        path: "data.default_tip[].des",
        group: "general",
      },
      {
        path: "data.default_tip[].icon",
        group: "general",
      },
      {
        path: "data.default_tip[].move_type",
        group: "general",
      },
      {
        path: "data.default_tip[].title",
        group: "general",
      },
      {
        path: "data.default_value",
        group: "general",
      },
      {
        path: "data.function_id",
        group: "capability",
      },
      {
        path: "data.id",
        group: "identity",
      },
      {
        path: "data.img",
        group: "identity",
      },
      {
        path: "data.middle_tip",
        group: "general",
      },
      {
        path: "data.model_id",
        group: "identity",
      },
      {
        path: "data.tips",
        group: "general",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
  ace: {
    path: "/v2/printer/getMultiColorBoxInfo",
    evidence: "live",
    note: "initial /v2/printer/multiColorBoxInfo returned 404",
    properties: [
      {
        path: "code",
        group: "envelope",
      },
      {
        path: "data",
        group: "general",
      },
      {
        path: "data[].auto_feed",
        group: "general",
      },
      {
        path: "data[].box_name",
        group: "ace",
      },
      {
        path: "data[].curr_nozzle_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data[].drying_status",
        group: "general",
      },
      {
        path: "data[].drying_status.duration",
        group: "general",
      },
      {
        path: "data[].drying_status.remain_time",
        group: "print",
        unit: "second",
      },
      {
        path: "data[].drying_status.status",
        group: "general",
      },
      {
        path: "data[].drying_status.target_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data[].feed_status",
        group: "general",
      },
      {
        path: "data[].feed_status.code",
        group: "general",
      },
      {
        path: "data[].feed_status.current_status",
        group: "general",
      },
      {
        path: "data[].feed_status.slot_index",
        group: "general",
      },
      {
        path: "data[].feed_status.type",
        group: "general",
      },
      {
        path: "data[].humidity",
        group: "general",
      },
      {
        path: "data[].id",
        group: "identity",
      },
      {
        path: "data[].loaded_slot",
        group: "general",
      },
      {
        path: "data[].model_id",
        group: "identity",
      },
      {
        path: "data[].slots",
        group: "general",
      },
      {
        path: "data[].slots[].color",
        group: "material",
      },
      {
        path: "data[].slots[].color_group",
        group: "material",
      },
      {
        path: "data[].slots[].consumables_percent",
        group: "general",
      },
      {
        path: "data[].slots[].edit_status",
        group: "general",
      },
      {
        path: "data[].slots[].icon_type",
        group: "general",
      },
      {
        path: "data[].slots[].index",
        group: "general",
      },
      {
        path: "data[].slots[].sku",
        group: "general",
      },
      {
        path: "data[].slots[].status",
        group: "general",
      },
      {
        path: "data[].slots[].type",
        group: "general",
      },
      {
        path: "data[].status",
        group: "general",
      },
      {
        path: "data[].target_nozzle_temp",
        group: "temperature",
        unit: "celsius",
      },
      {
        path: "data[].temp",
        group: "temperature",
      },
      {
        path: "msg",
        group: "envelope",
      },
    ],
  },
});
