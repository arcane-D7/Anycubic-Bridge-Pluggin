/**
 * Command catalog constants shared between the command bus and the MCP tools.
 * Split from printer-command-bus.mjs so tools can import the grammar without
 * pulling in the MQTT runtime.
 */
export const COMMANDS = Object.freeze({
  // ---- state (reversible, no motion) ----
  light_control: { type: "light", action: "control", safety: "state", evidence: "live" },
  fan_set: { type: "fan", action: "setSpeed", safety: "state", evidence: "mapping" },
  ace_auto_feed: {
    type: "multiColorBox",
    action: "setAutoFeed",
    safety: "state",
    evidence: "mapping",
  },
  ace_set_slot: { type: "multiColorBox", action: "setInfo", safety: "state", evidence: "mapping" },
  ai_settings_set: { type: "aiSettings", action: "switch", safety: "state", evidence: "reference" },
  // ---- thermal ----
  temperature_set: { type: "tempature", action: "set", safety: "thermal", evidence: "mapping" },
  ace_dry: { type: "multiColorBox", action: "setDry", safety: "thermal", evidence: "mapping" },
  print_update: {
    type: "print",
    action: "update",
    safety: "thermal",
    evidence: "mapping",
    note: "Changes settings of the RUNNING job (temps/fans/speed). It is NOT a refresh/status query.",
  },
  video_start_capture: {
    type: "video",
    action: "startCapture",
    safety: "state",
    evidence: "mapping",
  },
  video_stop_capture: {
    type: "video",
    action: "stopCapture",
    safety: "state",
    evidence: "mapping",
  },
  // ---- motion ----
  axis_move: { type: "axis", action: "move", safety: "motion", evidence: "mapping" },
  axis_turn_off: {
    type: "axis",
    action: "turnOff",
    safety: "motion",
    evidence: "mapping",
    note: "Disables stepper holding torque; the gantry/table can move or the part can drift.",
  },
  ace_feed: {
    type: "multiColorBox",
    action: "feedFilament",
    safety: "motion",
    evidence: "mapping",
  },
  // ---- job ----
  print_pause: { type: "print", action: "pause", safety: "job", evidence: "mapping" },
  print_resume: { type: "print", action: "resume", safety: "job", evidence: "mapping" },
  print_stop: { type: "print", action: "stop", safety: "job", evidence: "mapping" },
  print_start: { type: "print", action: "start", safety: "job", evidence: "mapping" },
  // ---- read ----
  print_query: { type: "print", action: "query", safety: "read", evidence: "reference" },
});

export const COMMAND_SAFETY = Object.freeze({
  /** Safety classes that require the extra confirm_word: "EXECUTE". */
  EXECUTE_WORD: Object.freeze(new Set(["motion", "job"])),
});
