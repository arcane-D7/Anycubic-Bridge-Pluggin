/**
 * S9.8-005 (G38) — i18n core: pure EN/PT-BR string table + helpers.
 *
 * Every UI string in the editor is extracted here (single source of truth).
 * The layer contract:
 *
 * - `Locale = "en" | "pt-BR"` — the ONLY supported locales in 9.8-005.
 * - `defaultLocale()` — system locale detection: PT-BR when
 *   `navigator.language.startsWith("pt")`, EN otherwise. Never throws;
 *   the guard keeps Node 24 headless runs safe (no `navigator` there).
 * - `STRINGS` — the full table (namespaced dotted keys, identical key set
 *   for EN and PT-BR; parity is enforced by `localeKeysMatch` + the unit
 *   tests, and by `i18n.ts` at boot).
 * - `interpolate(template, params)` — `{name}` placeholder substitution,
 *   locale-invariant (numbers/units stay raw; only the words translate).
 *
 * Product nouns / engineering terms (PLA, PETG, ABS, ASA, TPU, Grid, Gyroid,
 * Continuous Z, Auto-repair, IR, …) and language-neutral glyphs/abbreviations
 * (F/R/B/L/T/D, Dist/R/∠, ⌂, ⇱, ⇲, mm, °C, rev N, "—") are intentionally NOT
 * in the table — they read the same in both locales (spec §3.5 keeps the
 * font stack identical: Inter + JetBrains Mono cover both glyph sets).
 *
 * The core is dependency-free: no React, no zustand, no navigator access at
 * import time, so `node --test` runs it headless (same pattern as
 * `dirty-core` / `toolbar-core`).
 */

export type Locale = "en" | "pt-BR";

/** Locales API. `defaultLocale()` is called by the store at boot; the core
 * stays silent about persistence (the store owns the localStorage key). */
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "pt-BR"];

/** localStorage key for the locale preference (per-context, never a path —
 * AGENTS.md golden rule). */
export const LOCALE_KEY = "anycubic:locale";

/** Default: system locale — PT-BR if the browser language starts with "pt". */
export function defaultLocale(): Locale {
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    return navigator.language.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
  }
  return "en";
}

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "pt-BR";
}

/** All keys, in canonical (EN) order — the parity contract for both tables. */
export type MsgKey =
  // app shell -----------------------------------------------------------
  | "app.brand"
  | "app.tab.prepare"
  | "app.tab.preview"
  | "app.sidebarToggle"
  | "app.bridgeState.fetching"
  | "app.bridgeState.demo"
  | "app.bridgeState.unavailable"
  | "app.shortcutHelp.aria"
  | "app.shortcutHelp.title"
  | "app.sidebarNav.aria"
  | "app.view.settings"
  | "app.view.objects"
  | "app.view.chat"
  | "app.chat.detachAria"
  | "app.chat.detachTitle"
  | "app.viewport.aria"
  | "app.workspaceView.aria"
  // IR preview ------------------------------------------------------------
  | "app.ir.aria"
  | "app.ir.title"
  | "app.ir.fileLabel"
  | "app.ir.clear"
  | "app.ir.loaded"
  | "app.ir.empty"
  | "app.ir.sizeError"
  | "app.ir.modeSwitchRejected"
  | "app.ir.modeLockReason"
  // plate / echo ----------------------------------------------------------
  | "app.plate.operatorFallback"
  | "app.plate.volumeFallback"
  | "app.plate.volume"
  | "app.divider.ariaVertical"
  | "app.toast.demo.title"
  | "app.toast.demo.message"
  | "app.toast.dismissAria"
  | "modal.transformValueAria"
  | "snap.step"
  | "dirty.unsaved"
  | "dirty.saved"
  | "dirty.tooltip"
  | "dirty.save.aria"
  | "dirty.save.title"
  | "dirty.save.label"
  | "dirty.restore.aria"
  | "dirty.restore.title"
  | "dirty.restore.label"
  | "dirty.toast.saveError.title"
  | "dirty.toast.saveError.message"
  | "dirty.toast.saved.title"
  | "dirty.toast.saved.message"
  | "dirty.toast.restoreError.title"
  | "dirty.toast.restoreError.message"
  | "dirty.toast.restored.title"
  | "dirty.toast.restored.message"
  // toolbar ----------------------------------------------------------------
  | "toolbar.aria"
  | "toolbar.group.transform.aria"
  | "toolbar.group.view.aria"
  | "toolbar.group.scene.aria"
  | "toolbar.tool.select"
  | "toolbar.tool.move"
  | "toolbar.tool.rotate"
  | "toolbar.tool.scale"
  | "toolbar.tool.measure"
  | "toolbar.preset.isometric"
  | "toolbar.preset.top"
  | "toolbar.preset.front"
  | "toolbar.preset.right"
  | "toolbar.preset.aria"
  | "toolbar.preset.title"
  | "toolbar.tool.title"
  | "toolbar.toggle.snap.aria"
  | "toolbar.toggle.snap.title"
  | "toolbar.toggle.grid.aria"
  | "toolbar.toggle.grid.title"
  | "toolbar.toggle.labels.aria"
  | "toolbar.toggle.labels.title"
  | "toolbar.snapStep.title"
  | "toolbar.snapStep.srText"
  | "toolbar.snapStep.aria"
  | "toolbar.arrange.title"
  | "toolbar.arrange.aria"
  | "toolbar.arrange.titleAttr"
  | "toolbar.arrange.bridgeUnavailable"
  | "toolbar.arrange.noObjects"
  | "toolbar.arrange.overflowTitle"
  | "toolbar.arrange.overflowMsg"
  | "toolbar.arrange.successMsg"
  | "toolbar.arrange.failed"
  | "toolbar.fit.aria"
  | "toolbar.fit.title"
  | "toolbar.presets.aria"
  | "toolbar.view.infoTitle"
  | "toolbar.view.infoMsg"
  // printer picker --------------------------------------------------------
  | "printer.led.aria"
  | "printer.led.title.probing"
  | "printer.led.title.online"
  | "printer.led.title.offline"
  | "printer.timeAgo.never"
  | "printer.timeAgo.now"
  | "printer.timeAgo.seconds"
  | "printer.timeAgo.minutes"
  | "printer.summary.aria"
  | "printer.summary.title"
  | "printer.trigger.pick"
  | "printer.trigger.none"
  | "printer.panel.aria"
  | "printer.panel.title"
  | "printer.refresh.aria"
  | "printer.refresh.title"
  | "printer.empty"
  | "printer.list.aria"
  | "printer.row.title"
  | "printer.foot.probing"
  | "printer.foot.refreshed"
  // device panel --------------------------------------------------------
  | "device.panel.aria"
  | "device.panel.title"
  | "device.button.title"
  | "device.button.aria"
  | "device.tab.monitor"
  | "device.tab.filament"
  | "device.empty.title"
  | "device.empty.msg"
  | "device.offline.banner"
  | "device.stale.banner"
  | "device.temp.nozzle"
  | "device.temp.bed"
  | "device.temp.chamber"
  | "device.temp.current"
  | "device.temp.target"
  | "device.fans.part"
  | "device.fans.hotend"
  | "device.fans.aria"
  | "device.peripherals.title"
  | "device.peripherals.camera"
  | "device.peripherals.ace"
  | "device.peripherals.usb"
  | "device.camera.title"
  | "device.camera.start"
  | "device.camera.aria"
  | "device.motion.title"
  | "device.motion.xyz"
  | "device.ai.title"
  | "device.ai.enabled"
  | "device.ai.sensitivity"
  | "device.lights.title"
  | "device.lights.on"
  | "device.lights.off"
  | "device.identity.title"
  | "device.identity.machine"
  | "device.identity.firmware"
  | "device.identity.serial"
  | "device.identity.nozzle"
  | "device.storage.title"
  | "device.storage.kind"
  | "device.storage.used"
  | "device.storage.free"
  | "device.print.title"
  | "device.print.state.unknown"
  | "device.print.state.idle"
  | "device.print.state.printing"
  | "device.print.state.paused"
  | "device.print.state.error"
  | "device.print.state.offline"
  | "device.print.file"
  | "device.print.layer"
  | "device.print.progress"
  | "device.print.remaining"
  | "device.print.speed.silent"
  | "device.print.speed.standard"
  | "device.print.speed.sport"
  | "device.capabilities.title"
  | "device.capabilities.none"
  // status bar -------------------------------------------------------------
  | "status.objects"
  | "status.coords.title"
  | "status.plateDims.title"
  | "status.dirty.title"
  | "status.dirty.text"
  | "status.dirtyChip.title"
  | "status.dirtyChip.text"
  // theme -------------------------------------------------------------------
  | "theme.trigger.aria"
  | "theme.trigger.title"
  | "theme.menu.label"
  | "theme.option.light"
  | "theme.option.dark"
  | "theme.option.system"
  // slice --------------------------------------------------------------------
  | "slice.button.aria.eligible"
  | "slice.button.aria.blocked"
  | "slice.blocked.title"
  | "slice.toast.blockedTitle"
  | "slice.toast.blockedMessage"
  | "slice.toast.cannotTitle"
  | "slice.stage.active"
  | "slice.stage.busy"
  | "slice.button.idle"
  | "slice.failed.title"
  | "slice.ready.title"
  | "slice.ready.message"
  | "slice.stage.prepare"
  | "slice.stage.planarCore"
  | "slice.stage.ir"
  | "slice.stage.postprocess"
  | "slice.stage.preview"
  | "slice.progress.title"
  | "slice.progress.cancel"
  | "slice.progress.meta"
  // slice stats ---------------------------------------------------------------
  | "slice.stats.aria"
  | "slice.stats.title"
  | "slice.stats.layers"
  | "slice.stats.time"
  | "slice.stats.material"
  | "slice.stats.volume"
  // import ---------------------------------------------------------------------
  | "import.unsupported"
  | "import.failed.message"
  | "import.failed.fallback"
  | "import.title"
  | "import.description"
  | "import.browse.none"
  | "import.preview.triangles"
  | "import.preview.vertices"
  | "import.preview.size"
  | "import.options.aria"
  | "import.option.center"
  | "import.option.orientFlat"
  | "import.option.keepUnits"
  | "import.cancel"
  | "import.commit.busy"
  | "import.commit.idle"
  // chat / conversations -------------------------------------------------------
  | "chat.thread.empty.title"
  | "chat.thread.empty.hint"
  | "chat.role.user"
  | "chat.role.assistant"
  | "chat.thinking"
  | "chat.input.placeholder"
  | "chat.send"
  | "chat.title"
  | "chat.switchConversation.title"
  | "conversation.none"
  | "conversation.empty"
  | "conversation.new"
  | "conversation.dirty.title"
  | "conversation.dirty.clean"
  | "conversation.switch.title"
  | "conversation.tokenbar.title"
  | "conversation.meta"
  | "conversation.rename.aria"
  | "conversation.delete.aria"
  // dock -----------------------------------------------------------------
  | "dock.chat.title"
  | "dock.dockTitle"
  | "dock.collapseTitle"
  | "dock.floatingDesc"
  | "dock.resizeTitle"
  | "dock.expandTitle"
  // object tree ------------------------------------------------------------
  | "objectTree.label"
  | "objectTree.title"
  | "objectTree.loading"
  | "objectTree.empty"
  | "objectTree.columns.aria"
  | "objectTree.sortName.title"
  | "objectTree.sortName"
  | "objectTree.col.centerX"
  | "objectTree.col.centerY"
  | "objectTree.col.centerZ"
  | "objectTree.col.footprint"
  | "objectTree.col.volume"
  | "objectTree.col.footprintShort"
  | "objectTree.col.volumeShort"
  | "objectTree.hide"
  | "objectTree.show"
  | "objectTree.hideObj"
  | "objectTree.showObj"
  | "objectTree.unlock"
  | "objectTree.unlockObj"
  | "objectTree.lock"
  | "objectTree.lockObj"
  | "objectTree.rename.aria"
  | "objectTree.provenance"
  | "objectTree.repair.title"
  | "objectTree.repair.label"
  | "objectTree.repair"
  | "objectTree.mesh.aria"
  | "objectTree.placement.aria"
  | "objectTree.menu.title"
  | "objectTree.menu.aria"
  | "objectTree.add.title"
  | "objectTree.add"
  | "objectTree.duplicate.title"
  | "objectTree.delete.title"
  | "objectTree.arrange.title"
  | "objectTree.toast.repair.title"
  | "objectTree.toast.repair.watertight"
  | "objectTree.toast.repair.bridgeError"
  | "objectTree.toast.repair.asCopy"
  // object settings --------------------------------------------------------
  | "objectSettings.label"
  | "objectSettings.title"
  | "objectSettings.selectHint"
  | "objectSettings.mode.overridden"
  | "objectSettings.mode.global"
  | "objectSettings.resetParent"
  | "objectSettings.override"
  | "objectSettings.filament"
  | "objectSettings.filament.global"
  | "objectSettings.forkedValues"
  | "objectSettings.field.layerHeight"
  | "objectSettings.field.lineWidth"
  | "objectSettings.field.nozzle"
  | "objectSettings.field.wallLoops"
  | "objectSettings.field.topBottom"
  | "objectSettings.field.infillDensity"
  | "objectSettings.field.nozzleTemp"
  | "objectSettings.field.bedTemp"
  | "objectSettings.field.partFan"
  | "objectSettings.field.printSpeed"
  // settings panel ------------------------------------------------------------
  | "settings.aria"
  | "settings.heading"
  | "settings.draftBadge"
  | "settings.tabs.aria"
  | "settings.tabs.printer"
  | "settings.tabs.filament"
  | "settings.tabs.process"
  | "settings.language"
  | "settings.language.hint"
  | "settings.presets"
  | "settings.printerProfile"
  | "settings.qualityPreset"
  | "settings.customLayerHeight"
  | "settings.machine"
  | "settings.selectPrinter"
  | "settings.plateVolume"
  | "settings.noProfile"
  | "settings.nozzleDiameter"
  | "settings.motionCapabilities"
  | "settings.continuousZ"
  | "settings.continuousZ.unknown"
  | "settings.continuousZ.supported"
  | "settings.continuousZ.unsupported"
  | "settings.source.operator"
  | "settings.source.undeclared"
  | "settings.filament"
  | "settings.activeColor"
  | "settings.material"
  | "settings.materialType"
  | "settings.diameter"
  | "settings.temperature"
  | "settings.nozzle"
  | "settings.bed"
  | "settings.cooling"
  | "settings.partFan"
  | "settings.quality"
  | "settings.strength"
  | "settings.topBottom"
  | "settings.infillPattern"
  | "settings.infill.grid"
  | "settings.infill.gyroid"
  | "settings.speed"
  | "settings.print"
  | "settings.travel"
  | "settings.supportAdhesion"
  | "settings.generateSupports"
  | "settings.brim"
  | "settings.supports.on"
  | "settings.supports.off"
  | "settings.supports.brimSuffix"
  | "settings.supports.summaryTail"
  | "settings.notEligible"
  | "settings.draftNote"
  | "settings.export"
  | "settings.layerHeight"
  | "settings.lineWidth"
  | "settings.wallLoops"
  | "settings.infillDensity"
  | "settings.applyPresetToast"
  // timeline -----------------------------------------------------------------
  | "timeline.label"
  | "timeline.journal.aria"
  | "timeline.undo"
  | "timeline.undo.title"
  | "timeline.redo"
  | "timeline.redo.title"
  | "timeline.seek.title"
  | "timeline.events.aria"
  | "timeline.slicing.title"
  | "timeline.slicing.label"
  | "slicing.mode.standard"
  | "slicing.mode.nonplanar"
  | "timeline.nonplanar.blocked"
  | "timeline.nonplanar.supported"
  | "timeline.nonplanar.undeclared"
  | "timeline.nonplanar.operator"
  | "timeline.nonplanar.enabled"
  | "timeline.menu.seek"
  | "timeline.menu.resetHead"
  // transform inspector --------------------------------------------------------
  | "transform.label"
  | "transform.title"
  | "transform.emptyHint"
  | "transform.abs"
  | "transform.rel"
  | "transform.mode.relative"
  | "transform.mode.absolute"
  | "transform.mode.title"
  | "transform.copy.title"
  | "transform.copy.label"
  | "transform.reset.title"
  | "transform.reset.label"
  | "transform.axis.label"
  | "transform.kind.position"
  | "transform.kind.rotation"
  | "transform.kind.scale"
  | "transform.warning.nonUniform"
  | "transform.note.resized"
  | "transform.toast.rejected.title"
  | "transform.toast.failed"
  | "transform.toast.invalid.title"
  | "transform.toast.invalid.message"
  // boolean tool ---------------------------------------------------------------
  | "boolean.label"
  | "boolean.title"
  | "boolean.arm"
  | "boolean.armed"
  | "boolean.arm.label"
  | "boolean.arm.hint"
  | "boolean.operation"
  | "boolean.op.union"
  | "boolean.op.subtract"
  | "boolean.op.intersect"
  | "boolean.objectA"
  | "boolean.objectB"
  | "boolean.selectA"
  | "boolean.selectB"
  | "boolean.preview.template"
  | "boolean.preview.pick"
  | "boolean.hideSources"
  | "boolean.execute"
  | "boolean.committed"
  | "boolean.toast.warning.title"
  | "boolean.toast.warning.message"
  | "boolean.toast.done"
  | "boolean.toast.sourcesHidden"
  | "boolean.toast.sourcesKept"
  // measure ---------------------------------------------------------------------
  | "measure.kind.label"
  | "measure.kind.distance"
  | "measure.kind.radius"
  | "measure.kind.angle"
  | "measure.prompt.distance"
  | "measure.prompt.radius"
  | "measure.prompt.angle"
  | "measure.pts"
  | "measure.pending"
  | "measure.clear.aria"
  | "measure.clear"
  // viewport ---------------------------------------------------------------------
  | "viewport.preview.mode"
  | "viewport.preview.layerOf"
  | "viewport.preview.walls"
  | "viewport.preview.infill"
  | "viewport.repairLabel"
  | "viewport.dropHint"
  | "viewport.menu.arrange"
  | "viewport.menu.measure"
  | "viewport.menu.import"
  | "viewport.toast.arrange.title"
  | "viewport.toast.arrange.message"
  | "viewport.toast.measure.title"
  | "viewport.toast.measure.message"
  // view cube -------------------------------------------------------------------
  | "viewCube.aria"
  | "viewCube.home"
  | "viewCube.face"
  | "viewCube.corner"
  // labels / badges ------------------------------------------------------------
  | "labels.note.watertight"
  | "labels.note.repair"
  | "labels.note.locked"
  // plate tabs -------------------------------------------------------------------
  | "plateTabs.aria"
  | "plateTabs.unsaved"
  | "plateTabs.add.aria"
  | "plateTabs.add.title"
  | "plateTabs.unsavedDot"
  // context menus -----------------------------------------------------------------
  | "menu.duplicate"
  | "menu.rename"
  | "menu.hide"
  | "menu.show"
  | "menu.placeOnPlate"
  | "menu.repairReplace"
  | "menu.repairCopy"
  | "menu.delete"
  | "menu.plate.duplicate"
  | "menu.plate.rename"
  | "menu.plate.moveHeader"
  // shortcuts -----------------------------------------------------------------------
  | "shortcut.tool.select"
  | "shortcut.tool.move"
  | "shortcut.tool.rotate"
  | "shortcut.tool.scale"
  | "shortcut.view.fit"
  | "shortcut.view.iso"
  | "shortcut.view.top"
  | "shortcut.view.front"
  | "shortcut.view.right"
  | "shortcut.edit.undo"
  | "shortcut.edit.redo"
  | "shortcut.object.duplicate"
  | "shortcut.object.delete"
  | "shortcut.measure.toggle"
  | "shortcut.snap.toggle"
  | "shortcut.grid.toggle"
  | "shortcut.object.grabMove"
  | "shortcut.object.grabRotate"
  | "shortcut.object.grabScale"
  | "shortcut.object.constrainAxis"
  | "shortcut.object.grabConfirm"
  | "shortcut.object.grabCancel"
  | "shortcut.edit.redoShift"
  | "shortcut.help.frame"
  | "shortcut.help.toolSwitch"
  | "shortcut.group.transform"
  | "shortcut.group.tools"
  | "shortcut.group.scene"
  | "shortcut.group.edit"
  // context-menu ---------------------------------------------------------------------
  | "contextMenu.aria"
  // send-to-printer dialog ----------------------------------------------------------
  | "send.token.title"
  | "send.payloadChanged"
  | "send.task"
  | "send.sendBlocked"
  | "send.approveCardFirst"
  | "send.payloadChangedMessage"
  | "send.offline.title"
  | "send.sendFailed"
  | "send.printerOffline"
  | "send.jobSent.title"
  | "send.jobSent.message"
  | "send.sendTitle"
  | "send.sendToPrinter"
  | "send.stage.negotiate"
  | "send.stage.upload"
  | "send.stage.queue"
  | "send.reject"
  | "send.approve"
  | "send.dismiss"
  // shared verb fragments ---------------------------------------------------------
  | "common.cancel"
  | "common.undo"
  | "common.redo"
  | "common.empty";

/** Canonical EN strings (UI copy as it reads today). */
export const EN: Record<MsgKey, string> = {
  "app.brand": "Anycubic Bridge Editor",
  "app.tab.prepare": "Prepare",
  "app.tab.preview": "Preview",
  "app.sidebarToggle": "Settings",
  "app.bridgeState.fetching": "bridge: loading…",
  "app.bridgeState.demo": "Demo geometry",
  "app.bridgeState.unavailable": "bridge: unavailable",
  "app.shortcutHelp.aria": "Keyboard shortcuts help",
  "app.shortcutHelp.title": "Keyboard shortcuts",
  "app.sidebarNav.aria": "Sidebar view",
  "app.view.settings": "settings",
  "app.view.objects": "objects",
  "app.view.chat": "chat",
  "app.chat.detachAria": "Detach chat",
  "app.chat.detachTitle": "Detach chat to floating panel",
  "app.viewport.aria": "3D viewport",
  "app.workspaceView.aria": "Workspace view",
  "app.ir.aria": "IR preview loader",
  "app.ir.title": "IR preview",
  "app.ir.fileLabel": "Load IR document (JSON)",
  "app.ir.clear": "Clear preview",
  "app.ir.loaded": "{n} layer{s} · mode: {mode}",
  "app.ir.empty": "No IR document loaded.",
  "app.ir.sizeError": '"{name}" is larger than the 20 MB IR limit and was not read.',
  "app.ir.modeSwitchRejected":
    'Mode switch rejected — the loaded preview is "{mode}". Clear it before switching the slicing mode.',
  "app.ir.modeLockReason": "Loaded preview pins the slicing mode ({mode}) — clear it to change.",
  "app.plate.operatorFallback": "Select a printer",
  "app.plate.volumeFallback": "Demo plate",
  "app.plate.volume": "{w} x {d} x {h} mm",
  "app.divider.ariaVertical": "Resize settings panel",
  "app.toast.demo.title": "Ready",
  "app.toast.demo.message": "Liquid-glass shell initialized.",
  "app.toast.dismissAria": "Dismiss notification",
  "modal.transformValueAria": "Transform value",
  "snap.step": "step {step}",
  "dirty.unsaved": "{n} unsaved",
  "dirty.saved": "saved",
  "dirty.tooltip": "Last local commit",
  "dirty.save.aria": "Save scene locally",
  "dirty.save.title": "Save scene locally",
  "dirty.save.label": "save",
  "dirty.restore.aria": "Restore scene from local backup",
  "dirty.restore.title": "Restore scene from local backup",
  "dirty.restore.label": "restore",
  "dirty.toast.saveError.title": "Save scene",
  "dirty.toast.saveError.message": "save failed",
  "dirty.toast.saved.title": "Scene saved",
  "dirty.toast.saved.message": "Scene persisted locally.",
  "dirty.toast.restoreError.title": "Restore scene",
  "dirty.toast.restoreError.message": "no backup",
  "dirty.toast.restored.title": "Scene restored",
  "dirty.toast.restored.message": "{n} object{s} restored from local backup.",
  "toolbar.aria": "Viewport tools",
  "toolbar.group.transform.aria": "Transform tools",
  "toolbar.group.view.aria": "View toggles",
  "toolbar.group.scene.aria": "Scene actions",
  "toolbar.tool.select": "Select",
  "toolbar.tool.move": "Move",
  "toolbar.tool.rotate": "Rotate",
  "toolbar.tool.scale": "Scale",
  "toolbar.tool.measure": "Measure",
  "toolbar.preset.isometric": "Isometric",
  "toolbar.preset.top": "Top",
  "toolbar.preset.front": "Front",
  "toolbar.preset.right": "Right",
  "toolbar.preset.aria": "View {label}",
  "toolbar.preset.title": "{label} ({key})",
  "toolbar.tool.title": "{label} ({shortcut})",
  "toolbar.toggle.snap.aria": "Snap",
  "toolbar.toggle.snap.title": "Snap ({shortcut})",
  "toolbar.toggle.grid.aria": "Grid",
  "toolbar.toggle.grid.title": "Grid ({shortcut})",
  "toolbar.toggle.labels.aria": "Labels",
  "toolbar.toggle.labels.title": "Object labels (hover / always-on)",
  "toolbar.snapStep.title": "Snap step (mm)",
  "toolbar.snapStep.srText": "Snap step mm",
  "toolbar.snapStep.aria": "Snap step (mm)",
  "toolbar.arrange.title": "Arrange",
  "toolbar.arrange.aria": "Arrange",
  "toolbar.arrange.titleAttr": "Auto-arrange",
  "toolbar.arrange.bridgeUnavailable": "Bridge unavailable.",
  "toolbar.arrange.noObjects": "Nothing on the active plate to arrange.",
  "toolbar.arrange.overflowTitle": "Arrange — overflow",
  "toolbar.arrange.overflowMsg": "{n} object{s} exceed the plate ({first}).",
  "toolbar.arrange.successMsg": "Re-committed {n} object{s} onto the active plate.",
  "toolbar.arrange.failed": "Arrange failed — see console.",
  "toolbar.fit.aria": "Fit view",
  "toolbar.fit.title": "Fit view ({shortcut})",
  "toolbar.presets.aria": "View presets",
  "toolbar.view.infoTitle": "Arrange",
  "toolbar.view.infoMsg": "Use the toolbar Arrange for shelf packing.",
  "printer.led.aria": "{ip} {state}",
  "printer.led.title.probing": "Probing…",
  "printer.led.title.online": "Online",
  "printer.led.title.offline": "Offline",
  "printer.timeAgo.never": "not yet probed",
  "printer.timeAgo.now": "just now",
  "printer.timeAgo.seconds": "{n}s ago",
  "printer.timeAgo.minutes": "{n}m ago",
  "printer.summary.aria": "Select printer",
  "printer.summary.title": "Printer target",
  "printer.trigger.pick": "Pick printer",
  "printer.trigger.none": "No printer",
  "printer.panel.aria": "Discovered printers",
  "printer.panel.title": "Printer target",
  "printer.refresh.aria": "Re-probe printers",
  "printer.refresh.title": "Re-probe reachability",
  "printer.empty": "No printers discovered. Set {env} (comma-separated IPs).",
  "printer.list.aria": "Printers",
  "printer.row.title": "Arm send target {ip}",
  "printer.foot.probing": "probing…",
  "printer.foot.refreshed": "refreshed {timeAgo}",
  "device.panel.aria": "Printer device panel",
  "device.panel.title": "Device",
  "device.button.title": "Printer device panel",
  "device.button.aria": "Open printer device panel",
  "device.tab.monitor": "Monitor",
  "device.tab.filament": "Filament",
  "device.empty.title": "No printer selected",
  "device.empty.msg": "Pick a printer in the header to see live data.",
  "device.offline.banner": "Printer unreachable — showing last known data",
  "device.stale.banner": "Data is stale — reconnecting…",
  "device.temp.nozzle": "Nozzle",
  "device.temp.bed": "Bed",
  "device.temp.chamber": "Chamber",
  "device.temp.current": "current",
  "device.temp.target": "target",
  "device.fans.part": "Part cooling",
  "device.fans.hotend": "Hot end",
  "device.fans.aria": "Fan speed",
  "device.peripherals.title": "Peripherals",
  "device.peripherals.camera": "Camera",
  "device.peripherals.ace": "ACE unit",
  "device.peripherals.usb": "USB drive",
  "device.camera.title": "Camera",
  "device.camera.start": "Start camera",
  "device.camera.aria": "Start on-demand camera preview",
  "device.motion.title": "Toolhead",
  "device.motion.xyz": "X {x} · Y {y} · Z {z}",
  "device.ai.title": "AI monitoring",
  "device.ai.enabled": "Enabled",
  "device.ai.sensitivity": "Sensitivity",
  "device.lights.title": "Chamber light",
  "device.lights.on": "On",
  "device.lights.off": "Off",
  "device.identity.title": "Printer",
  "device.identity.machine": "Machine",
  "device.identity.firmware": "Firmware",
  "device.identity.serial": "Serial",
  "device.identity.nozzle": "Nozzle",
  "device.storage.title": "Storage",
  "device.storage.kind": "Kind",
  "device.storage.used": "Used",
  "device.storage.free": "Free",
  "device.print.title": "Print job",
  "device.print.state.unknown": "Unknown",
  "device.print.state.idle": "Idle",
  "device.print.state.printing": "Printing",
  "device.print.state.paused": "Paused",
  "device.print.state.error": "Error",
  "device.print.state.offline": "Offline",
  "device.print.file": "File",
  "device.print.layer": "Layer {curr} / {total}",
  "device.print.progress": "{pct}%",
  "device.print.remaining": "≈{secs}s left",
  "device.print.speed.silent": "Silent",
  "device.print.speed.standard": "Standard",
  "device.print.speed.sport": "Sport",
  "device.capabilities.title": "Capabilities",
  "device.capabilities.none": "None reported",
  "status.objects": "{n} object{s}",
  "status.coords.title": "{name} position (mm)",
  "status.plateDims.title": "{plate} scene bounds (mm)",
  "status.dirty.title": "{name}: uncommitted {kinds} edit",
  "status.dirty.text": "{name}: {kinds}",
  "status.dirtyChip.title": "{plate}: {n} unsaved object{s}",
  "status.dirtyChip.text": "● {n} unsaved",
  "theme.trigger.aria": "Theme",
  "theme.trigger.title": "Theme (light / dark / system)",
  "theme.menu.label": "Theme",
  "theme.option.light": "Light",
  "theme.option.dark": "Dark",
  "theme.option.system": "System",
  "slice.button.aria.eligible": "Slice active plate",
  "slice.button.aria.blocked": "Cannot slice — no watertight objects",
  "slice.blocked.title": "Repair before slicing: {names}",
  "slice.toast.blockedTitle": "Slice blocked",
  "slice.toast.blockedMessage": "Non-watertight objects on this plate: {names}",
  "slice.toast.cannotTitle": "Cannot slice",
  "slice.stage.active": "Slicing · {stage}…",
  "slice.stage.busy": "Slicing…",
  "slice.button.idle": "Slice",
  "slice.failed.title": "Slice failed",
  "slice.ready.title": "Slice ready",
  "slice.ready.message": "{layers} layers · {min} min",
  "slice.stage.prepare": "prepare",
  "slice.stage.planarCore": "planar-core",
  "slice.stage.ir": "IR",
  "slice.stage.postprocess": "postprocess",
  "slice.stage.preview": "preview",
  "slice.progress.title": "Slicing {stage}",
  "slice.progress.cancel": "Cancel",
  "slice.progress.meta": "{n}/{total} · {pct}%",
  "slice.stats.aria": "Slice statistics",
  "slice.stats.title": "Slice stats",
  "slice.stats.layers": "Layers",
  "slice.stats.time": "Est. time",
  "slice.stats.material": "Material",
  "slice.stats.volume": "Volume",
  "import.unsupported": 'Unsupported file type — expected .stl or .3mf (got "{name}").',
  "import.failed.message": "Import failed: {err}",
  "import.failed.fallback": "Import failed.",
  "import.title": "Import model",
  "import.description":
    "STL (binary/ASCII) or 3MF — units mm, placed on the plate (z=0). Watertight status is computed on import.",
  "import.browse.none": "No file selected",
  "import.preview.triangles": "Triangles",
  "import.preview.vertices": "Vertices",
  "import.preview.size": "Size",
  "import.options.aria": "Import options",
  "import.option.center": "Center on plate",
  "import.option.orientFlat": "Orient flat",
  "import.option.keepUnits": "Keep units (mm)",
  "import.cancel": "Cancel",
  "import.commit.busy": "Importing…",
  "import.commit.idle": "Import",
  "chat.thread.empty.title": "No messages yet — offline dev transport (S9.6-005/008).",
  "chat.thread.empty.hint":
    "Send a message to get a canned mock reply; set {env} to pin the chat lane to the Rust broker loopback.",
  "chat.role.user": "user",
  "chat.role.assistant": "assistant",
  "chat.thinking": "thinking…",
  "chat.input.placeholder": 'Ask the harness… (try "request: geometry.boolean")',
  "chat.send": "Send",
  "chat.title": "Chat",
  "chat.switchConversation.title": "Switch conversation (active: {title})",
  "conversation.none": "none",
  "conversation.empty": "No conversations yet.",
  "conversation.new": "+ New conversation",
  "conversation.dirty.title": "Unsaved transcript (persistence lands in S9.6-007)",
  "conversation.dirty.clean": "Clean",
  "conversation.switch.title": "Switch · double-click to rename",
  "conversation.tokenbar.title": "{pct}% of budget used",
  "conversation.meta": "{n} src · {m} apv",
  "conversation.rename.aria": "Rename conversation",
  "conversation.delete.aria": "Delete conversation",
  "dock.chat.title": "AI Chat",
  "dock.dockTitle": "Dock panel",
  "dock.collapseTitle": "Collapse to pill",
  "dock.floatingDesc": "Floating {title} panel",
  "dock.resizeTitle": "Resize {title}",
  "dock.expandTitle": "Expand {title}",
  "objectTree.label": "Object tree",
  "objectTree.title": "Objects",
  "objectTree.loading": "Loading scene…",
  "objectTree.empty": "No objects.",
  "objectTree.columns.aria": "Object columns",
  "objectTree.sortName.title": "Sort by name",
  "objectTree.sortName": "Name",
  "objectTree.col.centerX": "Center X (mm)",
  "objectTree.col.centerY": "Center Y (mm)",
  "objectTree.col.centerZ": "Center Z (mm)",
  "objectTree.col.footprint": "Footprint (w × d)",
  "objectTree.col.volume": "Volume",
  "objectTree.col.footprintShort": "Ftp",
  "objectTree.col.volumeShort": "Vol",
  "objectTree.hide": "Hide",
  "objectTree.show": "Show",
  "objectTree.hideObj": "Hide object",
  "objectTree.showObj": "Show object",
  "objectTree.unlock": "Unlock",
  "objectTree.unlockObj": "Unlock object",
  "objectTree.lock": "Lock",
  "objectTree.lockObj": "Lock object",
  "objectTree.rename.aria": "Rename object",
  "objectTree.provenance": "{name} — {provenance}",
  "objectTree.repair.title": "Non-watertight — click to Auto-repair",
  "objectTree.repair.label": "Auto-repair {name}",
  "objectTree.repair": "repair",
  "objectTree.mesh.aria": "Mesh stats",
  "objectTree.placement.aria": "Placement metrics",
  "objectTree.menu.title": "Object menu",
  "objectTree.menu.aria": "Actions for {name}",
  "objectTree.add.title": "Add object (import)",
  "objectTree.add": "Add",
  "objectTree.duplicate.title": "Duplicate selected",
  "objectTree.delete.title": "Delete selected",
  "objectTree.arrange.title": "Arrange",
  "objectTree.toast.repair.title": "Auto-repair",
  "objectTree.toast.repair.watertight": "{name} is watertight{target}.",
  "objectTree.toast.repair.bridgeError": "Bridge error during repair.",
  "objectTree.toast.repair.asCopy": ' as "{object}"',
  "objectSettings.label": "Object print settings",
  "objectSettings.title": "Object settings",
  "objectSettings.selectHint":
    "Select an object to override its print settings or assign a filament.",
  "objectSettings.mode.overridden": "Overridden — this object does not use the global draft.",
  "objectSettings.mode.global": "Using global — object inherits the global print draft.",
  "objectSettings.resetParent": "Reset to parent",
  "objectSettings.override": "Override settings",
  "objectSettings.filament": "Filament",
  "objectSettings.filament.global": "Global",
  "objectSettings.forkedValues": "Forked values",
  "objectSettings.field.layerHeight": "Layer height",
  "objectSettings.field.lineWidth": "Line width",
  "objectSettings.field.nozzle": "Nozzle",
  "objectSettings.field.wallLoops": "Wall loops",
  "objectSettings.field.topBottom": "Top/bottom layers",
  "objectSettings.field.infillDensity": "Infill density",
  "objectSettings.field.nozzleTemp": "Nozzle temp",
  "objectSettings.field.bedTemp": "Bed temp",
  "objectSettings.field.partFan": "Part fan",
  "objectSettings.field.printSpeed": "Print speed",
  "settings.aria": "Slicer settings",
  "settings.heading": "Print settings",
  "settings.draftBadge": "Draft",
  "settings.tabs.aria": "Settings category",
  "settings.tabs.printer": "Printer",
  "settings.tabs.filament": "Filament",
  "settings.tabs.process": "Process",
  "settings.language": "Language",
  "settings.language.hint": "UI language — switches live.",
  "settings.presets": "Presets",
  "settings.printerProfile": "Printer profile",
  "settings.qualityPreset": "Quality preset",
  "settings.customLayerHeight": "Custom layer height",
  "settings.machine": "Machine",
  "settings.selectPrinter": "Select printer",
  "settings.plateVolume": "{w} x {d} x {h} mm",
  "settings.noProfile": "No printer profile selected",
  "settings.nozzleDiameter": "Nozzle diameter",
  "settings.motionCapabilities": "Motion capabilities",
  "settings.continuousZ": "Continuous Z",
  "settings.continuousZ.unknown": "Unknown",
  "settings.continuousZ.supported": "Supported",
  "settings.continuousZ.unsupported": "Unsupported",
  "settings.source.operator": "Source: operator declaration",
  "settings.source.undeclared": "Capability not yet declared",
  "settings.filament": "Filament",
  "settings.activeColor": "Active: {color}",
  "settings.material": "Material",
  "settings.materialType": "Type",
  "settings.diameter": "Diameter",
  "settings.temperature": "Temperature",
  "settings.nozzle": "Nozzle",
  "settings.bed": "Bed",
  "settings.cooling": "Cooling",
  "settings.partFan": "Part fan",
  "settings.quality": "Quality",
  "settings.strength": "Strength",
  "settings.topBottom": "Top / bottom layers",
  "settings.infillPattern": "Infill pattern",
  "settings.infill.grid": "Grid",
  "settings.infill.gyroid": "Gyroid subset",
  "settings.speed": "Speed",
  "settings.print": "Print",
  "settings.travel": "Travel",
  "settings.supportAdhesion": "Support & adhesion",
  "settings.generateSupports": "Generate supports",
  "settings.brim": "Brim",
  "settings.supports.on": "Supports",
  "settings.supports.off": "No supports",
  "settings.supports.brimSuffix": " · brim",
  "settings.supports.summaryTail": " — applied at slice time, gated by the watertight preflight.",
  "settings.notEligible": "Not eligible yet — objects on the plate must be watertight.",
  "settings.draftNote": "Draft parameters. Existing toolpaths are unchanged.",
  "settings.export": "Export settings",
  "settings.layerHeight": "Layer height",
  "settings.lineWidth": "Line width",
  "settings.wallLoops": "Wall loops",
  "settings.infillDensity": "Infill density",
  "settings.applyPresetToast": "Preset applied to draft",
  "timeline.label": "Timeline and slicing",
  "timeline.journal.aria": "Transform journal",
  "timeline.undo": "Undo",
  "timeline.undo.title": "Undo (Ctrl+Z)",
  "timeline.redo": "Redo",
  "timeline.redo.title": "Redo (Ctrl+Shift+Z / Ctrl+Y)",
  "timeline.seek.title": "Seek to revision {n}",
  "timeline.events.aria": "Events at {rev}",
  "timeline.slicing.title": "Slicing mode",
  "timeline.slicing.label": "Slicing mode",
  "slicing.mode.standard": "Standard (planar)",
  "slicing.mode.nonplanar": "Non-planar (experimental)",
  "timeline.nonplanar.blocked":
    "Continuous Z declared unsupported. Imported paths remain viewable.",
  "timeline.nonplanar.supported": "Continuous Z supported",
  "timeline.nonplanar.undeclared": "Continuous Z not yet declared",
  "timeline.nonplanar.operator": " (operator)",
  "timeline.nonplanar.enabled": "Non-planar editing enabled; print generation pending validation.",
  "timeline.menu.seek": "Seek to revision {revision}",
  "timeline.menu.resetHead": "Reset to journal head",
  "transform.label": "Transform inspector",
  "transform.title": "Transform",
  "transform.emptyHint": "Select an object to edit parts, position and scale.",
  "transform.abs": "abs",
  "transform.rel": "rel",
  "transform.mode.relative": "Relative mode",
  "transform.mode.absolute": "Absolute mode",
  "transform.mode.title": "{mode} — deltas for position/rotation, factors for scale",
  "transform.copy.title": "Copy X value into Y and Z",
  "transform.copy.label": "Copy {kind} X into Y and Z",
  "transform.reset.title": "Reset {kind} to {n}",
  "transform.reset.label": "Reset {kind}",
  "transform.axis.label": "{kind} {axis}",
  "transform.kind.position": "position",
  "transform.kind.rotation": "rotation",
  "transform.kind.scale": "scale",
  "transform.warning.nonUniform":
    "Non-uniform scale — thin walls may print poorly. Consider resetting scale to 1:1:1.",
  "transform.note.resized": "Scale changed from identity.",
  "transform.toast.rejected.title": "Transform rejected",
  "transform.toast.failed": "Transform failed",
  "transform.toast.invalid.title": "Invalid value",
  "transform.toast.invalid.message": "Numeric input expected.",
  "boolean.label": "Boolean tool",
  "boolean.title": "Boolean",
  "boolean.arm": "Arm",
  "boolean.armed": "Armed",
  "boolean.arm.label": "Arm boolean tool",
  "boolean.arm.hint": "Arm the boolean tool to combine two objects.",
  "boolean.operation": "Operation",
  "boolean.op.union": "Union",
  "boolean.op.subtract": "Subtract",
  "boolean.op.intersect": "Intersect",
  "boolean.objectA": "Object A",
  "boolean.objectB": "Object B",
  "boolean.selectA": "Select A…",
  "boolean.selectB": "Select B…",
  "boolean.preview.template": "Preview: {name} · {tri} tri · watertight (bounds {min}…{max} mm)",
  "boolean.preview.pick": "Pick two distinct watertight objects to preview.",
  "boolean.hideSources": "Hide source objects",
  "boolean.execute": "Execute {op}",
  "boolean.committed":
    "Committed — “{name}” is added to the scene (provenance noted, journal-safe).",
  "boolean.toast.warning.title": "Boolean",
  "boolean.toast.warning.message": "Pick two distinct watertight objects first.",
  "boolean.toast.done": "Boolean {verb}",
  "boolean.toast.sourcesHidden": "Sources hidden.",
  "boolean.toast.sourcesKept": "Sources kept.",
  "measure.kind.label": "Measure kind",
  "measure.kind.distance": "Dist",
  "measure.kind.radius": "R",
  "measure.kind.angle": "∠",
  "measure.prompt.distance": "Pick first point",
  "measure.prompt.radius": "Pick 3 points on a circular edge",
  "measure.prompt.angle": "Pick apex then two edges",
  "measure.pts": "{n}/{need} pts",
  "measure.pending": "{pending} — {prompt}",
  "measure.clear.aria": "Clear measurement",
  "measure.clear": "clear",
  "viewport.preview.mode": "mode: {mode}",
  "viewport.preview.layerOf": "Layer {n} of {total}",
  "viewport.preview.walls": "Walls",
  "viewport.preview.infill": "Infill",
  "viewport.repairLabel": "Needs repair:",
  "viewport.dropHint": "Drop to import",
  "viewport.menu.arrange": "Arrange objects",
  "viewport.menu.measure": "Measure",
  "viewport.menu.import": "Import…",
  "viewport.toast.arrange.title": "Arrange",
  "viewport.toast.arrange.message": "Use the toolbar Arrange for shelf packing.",
  "viewport.toast.measure.title": "Measure",
  "viewport.toast.measure.message": "Measure tool lands in a later sprint.",
  "viewCube.aria": "View cube",
  "viewCube.home": "Isometric (home)",
  "viewCube.face": "View {face} face",
  "viewCube.corner": "Isometric corner",
  "labels.note.watertight": "watertight",
  "labels.note.repair": "needs repair",
  "labels.note.locked": "locked",
  "plateTabs.aria": "Plates",
  "plateTabs.unsaved": "{name} · unsaved",
  "plateTabs.add.aria": "Add plate",
  "plateTabs.add.title": "Add plate",
  "plateTabs.unsavedDot": "Unsaved changes",
  "menu.duplicate": "Duplicate",
  "menu.rename": "Rename",
  "menu.hide": "Hide",
  "menu.show": "Show",
  "menu.placeOnPlate": "Place on plate",
  "menu.repairReplace": "Auto-repair (replace)",
  "menu.repairCopy": "Auto-repair (copy)",
  "menu.delete": "Delete",
  "menu.plate.duplicate": "Duplicate plate",
  "menu.plate.rename": "Rename…",
  "menu.plate.moveHeader": "Move objects to…",
  "shortcut.tool.select": "Select",
  "shortcut.tool.move": "Move",
  "shortcut.tool.rotate": "Rotate",
  "shortcut.tool.scale": "Scale",
  "shortcut.view.fit": "Fit view",
  "shortcut.view.iso": "Isometric view",
  "shortcut.view.top": "Top view",
  "shortcut.view.front": "Front view",
  "shortcut.view.right": "Right view",
  "shortcut.edit.undo": "Undo",
  "shortcut.edit.redo": "Redo",
  "shortcut.object.duplicate": "Duplicate",
  "shortcut.object.delete": "Delete",
  "shortcut.measure.toggle": "Measure",
  "shortcut.snap.toggle": "Snap",
  "shortcut.grid.toggle": "Grid",
  "shortcut.object.grabMove": "Move (grab)",
  "shortcut.object.grabRotate": "Rotate (grab)",
  "shortcut.object.grabScale": "Scale (grab)",
  "shortcut.object.constrainAxis": "Constrain axis",
  "shortcut.object.grabConfirm": "Confirm grab",
  "shortcut.object.grabCancel": "Cancel grab",
  "shortcut.edit.redoShift": "Redo (shift)",
  "shortcut.help.frame": "Frame selection",
  "shortcut.help.toolSwitch": "Select / Move / Rotate / Scale",
  "shortcut.group.transform": "Transform",
  "shortcut.group.tools": "Tools",
  "shortcut.group.scene": "Scene",
  "shortcut.group.edit": "Edit",
  "contextMenu.aria": "Context menu",
  "send.token.title": "Token hash — pins the exact approved payload",
  "send.payloadChanged": "payload changed since approval",
  "send.task": "task {id}",
  "send.sendBlocked": "Send blocked",
  "send.approveCardFirst": "approve the card first",
  "send.payloadChangedMessage": "payload changed — re-approve",
  "send.offline.title": "Printer offline",
  "send.sendFailed": "Send failed",
  "send.printerOffline": "Printer offline",
  "send.jobSent.title": "Print job sent",
  "send.jobSent.message": "{name} · {taskId}",
  "send.sendTitle": "Send to print",
  "send.sendToPrinter": "Send to printer",
  "send.stage.negotiate": "Negotiating with printer…",
  "send.stage.upload": "Uploading slice…",
  "send.stage.queue": "Queuing job…",
  "send.reject": "Reject",
  "send.approve": "Approve",
  "send.dismiss": "Dismiss",
  "common.cancel": "Cancel",
  "common.undo": "Undo",
  "common.redo": "Redo",
  "common.empty": "",
};

/** PT-BR strings (full parity — same keys as EN). */
export const PT_BR: Record<MsgKey, string> = {
  "app.brand": "Anycubic Bridge Editor",
  "app.tab.prepare": "Preparar",
  "app.tab.preview": "Pré-visualizar",
  "app.sidebarToggle": "Definições",
  "app.bridgeState.fetching": "bridge: a carregar…",
  "app.bridgeState.demo": "Geometria de demonstração",
  "app.bridgeState.unavailable": "bridge: indisponível",
  "app.shortcutHelp.aria": "Ajuda de atalhos de teclado",
  "app.shortcutHelp.title": "Atalhos de teclado",
  "app.sidebarNav.aria": "Vista da barra lateral",
  "app.view.settings": "definições",
  "app.view.objects": "objetos",
  "app.view.chat": "chat",
  "app.chat.detachAria": "Desprender chat",
  "app.chat.detachTitle": "Desprender chat para painel flutuante",
  "app.viewport.aria": "Viewport 3D",
  "app.workspaceView.aria": "Vista do espaço de trabalho",
  "app.ir.aria": "Carregador de pré-visualização IR",
  "app.ir.title": "Pré-visualização IR",
  "app.ir.fileLabel": "Carregar documento IR (JSON)",
  "app.ir.clear": "Limpar pré-visualização",
  "app.ir.loaded": "{n} camada{s} · modo: {mode}",
  "app.ir.empty": "Nenhum documento IR carregado.",
  "app.ir.sizeError": '"{name}" é maior que o limite de 20 MB de IR e não foi lido.',
  "app.ir.modeSwitchRejected":
    'Troca de modo rejeitada — a pré-visualização carregada é "{mode}". Limpe-a antes de mudar o modo de corte.',
  "app.ir.modeLockReason":
    "A pré-visualização carregada fixa o modo de corte ({mode}) — limpe-a para mudar.",
  "app.plate.operatorFallback": "Selecionar impressora",
  "app.plate.volumeFallback": "Placa de demonstração",
  "app.plate.volume": "{w} x {d} x {h} mm",
  "app.divider.ariaVertical": "Redimensionar painel de definições",
  "app.toast.demo.title": "Pronto",
  "app.toast.demo.message": "Casca de vidro líquido inicializada.",
  "app.toast.dismissAria": "Dispensar notificação",
  "modal.transformValueAria": "Valor de transformação",
  "snap.step": "passo {step}",
  "dirty.unsaved": "{n} por guardar",
  "dirty.saved": "guardado",
  "dirty.tooltip": "Último commit local",
  "dirty.save.aria": "Guardar cena localmente",
  "dirty.save.title": "Guardar cena localmente",
  "dirty.save.label": "guardar",
  "dirty.restore.aria": "Restaurar cena do backup local",
  "dirty.restore.title": "Restaurar cena do backup local",
  "dirty.restore.label": "restaurar",
  "dirty.toast.saveError.title": "Guardar cena",
  "dirty.toast.saveError.message": "falha ao guardar",
  "dirty.toast.saved.title": "Cena guardada",
  "dirty.toast.saved.message": "Cena persistida localmente.",
  "dirty.toast.restoreError.title": "Restaurar cena",
  "dirty.toast.restoreError.message": "sem backup",
  "dirty.toast.restored.title": "Cena restaurada",
  "dirty.toast.restored.message": "{n} objeto{s} restaurados do backup local.",
  "toolbar.aria": "Ferramentas do viewport",
  "toolbar.group.transform.aria": "Ferramentas de transformação",
  "toolbar.group.view.aria": "Alternadores de vista",
  "toolbar.group.scene.aria": "Ações de cena",
  "toolbar.tool.select": "Selecionar",
  "toolbar.tool.move": "Mover",
  "toolbar.tool.rotate": "Rodar",
  "toolbar.tool.scale": "Escalar",
  "toolbar.tool.measure": "Medir",
  "toolbar.preset.isometric": "Isométrica",
  "toolbar.preset.top": "Superior",
  "toolbar.preset.front": "Frontal",
  "toolbar.preset.right": "Direita",
  "toolbar.preset.aria": "Vista {label}",
  "toolbar.preset.title": "{label} ({key})",
  "toolbar.tool.title": "{label} ({shortcut})",
  "toolbar.toggle.snap.aria": "Snap",
  "toolbar.toggle.snap.title": "Snap ({shortcut})",
  "toolbar.toggle.grid.aria": "Grelha",
  "toolbar.toggle.grid.title": "Grelha ({shortcut})",
  "toolbar.toggle.labels.aria": "Etiquetas",
  "toolbar.toggle.labels.title": "Etiquetas de objeto (hover / sempre visíveis)",
  "toolbar.snapStep.title": "Passo de snap (mm)",
  "toolbar.snapStep.srText": "Passo de snap mm",
  "toolbar.snapStep.aria": "Passo de snap (mm)",
  "toolbar.arrange.title": "Arrumar",
  "toolbar.arrange.aria": "Arrumar",
  "toolbar.arrange.titleAttr": "Auto-arrumar",
  "toolbar.arrange.bridgeUnavailable": "Bridge indisponível.",
  "toolbar.arrange.noObjects": "Nada na placa ativa para arrumar.",
  "toolbar.arrange.overflowTitle": "Arrumar — excedente",
  "toolbar.arrange.overflowMsg": "{n} objeto{s} excedem a placa ({first}).",
  "toolbar.arrange.successMsg": "Re-commit de {n} objeto{s} na placa ativa.",
  "toolbar.arrange.failed": "Arrumar falhou — ver consola.",
  "toolbar.fit.aria": "Enquadrar vista",
  "toolbar.fit.title": "Enquadrar vista ({shortcut})",
  "toolbar.presets.aria": "Predefinições de vista",
  "toolbar.view.infoTitle": "Arrumar",
  "toolbar.view.infoMsg": "Use a barra de ferramentas Arrumar para empacotamento de prateleira.",
  "printer.led.aria": "{ip} {state}",
  "printer.led.title.probing": "A sondar…",
  "printer.led.title.online": "Online",
  "printer.led.title.offline": "Offline",
  "printer.timeAgo.never": "ainda não sondada",
  "printer.timeAgo.now": "agora mesmo",
  "printer.timeAgo.seconds": "há {n}s",
  "printer.timeAgo.minutes": "há {n}m",
  "printer.summary.aria": "Selecionar impressora",
  "printer.summary.title": "Alvo de impressão",
  "printer.trigger.pick": "Escolher impressora",
  "printer.trigger.none": "Sem impressora",
  "printer.panel.aria": "Impressoras descobertas",
  "printer.panel.title": "Alvo de impressão",
  "printer.refresh.aria": "Re-sondar impressoras",
  "printer.refresh.title": "Re-sondar alcance",
  "printer.empty": "Nenhuma impressora descoberta. Defina {env} (IPs separados por vírgulas).",
  "printer.list.aria": "Impressoras",
  "printer.row.title": "Armar alvo de envio {ip}",
  "printer.foot.probing": "a sondar…",
  "printer.foot.refreshed": "atualizado {timeAgo}",
  "device.panel.aria": "Painel do dispositivo da impressora",
  "device.panel.title": "Dispositivo",
  "device.button.title": "Painel do dispositivo da impressora",
  "device.button.aria": "Abrir painel do dispositivo da impressora",
  "device.tab.monitor": "Monitor",
  "device.tab.filament": "Filamento",
  "device.empty.title": "Nenhuma impressora selecionada",
  "device.empty.msg": "Escolha uma impressora no cabeçalho para ver dados ao vivo.",
  "device.offline.banner": "Impressora inacessível — a mostrar últimos dados conhecidos",
  "device.stale.banner": "Dados desatualizados — a reconectar…",
  "device.temp.nozzle": "Bico",
  "device.temp.bed": "Mesa",
  "device.temp.chamber": "Câmara",
  "device.temp.current": "atual",
  "device.temp.target": "alvo",
  "device.fans.part": "Arref. peça",
  "device.fans.hotend": "Hot end",
  "device.fans.aria": "Velocidade da ventoinha",
  "device.peripherals.title": "Periféricos",
  "device.peripherals.camera": "Câmara",
  "device.peripherals.ace": "Unidade ACE",
  "device.peripherals.usb": "Pen USB",
  "device.camera.title": "Câmara",
  "device.camera.start": "Iniciar câmara",
  "device.camera.aria": "Iniciar pré-visualização de câmara a pedido",
  "device.motion.title": "Cabeçote",
  "device.motion.xyz": "X {x} · Y {y} · Z {z}",
  "device.ai.title": "Monitorização IA",
  "device.ai.enabled": "Ativada",
  "device.ai.sensitivity": "Sensibilidade",
  "device.lights.title": "Luz da câmara",
  "device.lights.on": "Ligada",
  "device.lights.off": "Desligada",
  "device.identity.title": "Impressora",
  "device.identity.machine": "Máquina",
  "device.identity.firmware": "Firmware",
  "device.identity.serial": "Série",
  "device.identity.nozzle": "Bico",
  "device.storage.title": "Armazenamento",
  "device.storage.kind": "Tipo",
  "device.storage.used": "Usado",
  "device.storage.free": "Livre",
  "device.print.title": "Trabalho de impressão",
  "device.print.state.unknown": "Desconhecido",
  "device.print.state.idle": "Em espera",
  "device.print.state.printing": "A imprimir",
  "device.print.state.paused": "Em pausa",
  "device.print.state.error": "Erro",
  "device.print.state.offline": "Offline",
  "device.print.file": "Ficheiro",
  "device.print.layer": "Camada {curr} / {total}",
  "device.print.progress": "{pct}%",
  "device.print.remaining": "≈{secs}s restantes",
  "device.print.speed.silent": "Silencioso",
  "device.print.speed.standard": "Padrão",
  "device.print.speed.sport": "Sport",
  "device.capabilities.title": "Capacidades",
  "device.capabilities.none": "Nada reportado",
  "status.objects": "{n} objeto{s}",
  "status.coords.title": "{name} posição (mm)",
  "status.plateDims.title": "{plate} limites de cena (mm)",
  "status.dirty.title": "{name}: edição {kinds} não confirmada",
  "status.dirty.text": "{name}: {kinds}",
  "status.dirtyChip.title": "{plate}: {n} objeto{s} não gravado{s}",
  "status.dirtyChip.text": "● {n} por gravar",
  "theme.trigger.aria": "Tema",
  "theme.trigger.title": "Tema (claro / escuro / sistema)",
  "theme.menu.label": "Tema",
  "theme.option.light": "Claro",
  "theme.option.dark": "Escuro",
  "theme.option.system": "Sistema",
  "slice.button.aria.eligible": "Cortar placa ativa",
  "slice.button.aria.blocked": "Impossível cortar — sem objetos estanques",
  "slice.blocked.title": "Repare antes de cortar: {names}",
  "slice.toast.blockedTitle": "Corte bloqueado",
  "slice.toast.blockedMessage": "Objetos não estanques nesta placa: {names}",
  "slice.toast.cannotTitle": "Impossível cortar",
  "slice.stage.active": "A cortar · {stage}…",
  "slice.stage.busy": "A cortar…",
  "slice.button.idle": "Cortar",
  "slice.failed.title": "Falha de corte",
  "slice.ready.title": "Corte pronto",
  "slice.ready.message": "{layers} camadas · {min} min",
  "slice.stage.prepare": "preparação",
  "slice.stage.planarCore": "núcleo planar",
  "slice.stage.ir": "IR",
  "slice.stage.postprocess": "pós-processo",
  "slice.stage.preview": "pré-visualização",
  "slice.progress.title": "A cortar {stage}",
  "slice.progress.cancel": "Cancelar",
  "slice.progress.meta": "{n}/{total} · {pct}%",
  "slice.stats.aria": "Estatísticas de corte",
  "slice.stats.title": "Estatísticas de corte",
  "slice.stats.layers": "Camadas",
  "slice.stats.time": "Tempo est.",
  "slice.stats.material": "Material",
  "slice.stats.volume": "Volume",
  "import.unsupported": 'Tipo de ficheiro não suportado — esperado .stl ou .3mf (obtido "{name}").',
  "import.failed.message": "Falha de importação: {err}",
  "import.failed.fallback": "Falha de importação.",
  "import.title": "Importar modelo",
  "import.description":
    "STL (binário/ASCII) ou 3MF — unidades mm, colocado na placa (z=0). O estado estanque é calculado na importação.",
  "import.browse.none": "Nenhum ficheiro selecionado",
  "import.preview.triangles": "Triângulos",
  "import.preview.vertices": "Vértices",
  "import.preview.size": "Tamanho",
  "import.options.aria": "Opções de importação",
  "import.option.center": "Centralizar na placa",
  "import.option.orientFlat": "Assentar na horizontal",
  "import.option.keepUnits": "Manter unidades (mm)",
  "import.cancel": "Cancelar",
  "import.commit.busy": "A importar…",
  "import.commit.idle": "Importar",
  "chat.thread.empty.title": "Sem mensagens ainda — transporte dev offline (S9.6-005/008).",
  "chat.thread.empty.hint":
    "Envie uma mensagem para obter uma resposta mock; defina {env} para fixar o lane de chat ao loopback do broker Rust.",
  "chat.role.user": "utilizador",
  "chat.role.assistant": "assistente",
  "chat.thinking": "a pensar…",
  "chat.input.placeholder": 'Pergunte ao harness… (tente "request: geometry.boolean")',
  "chat.send": "Enviar",
  "chat.title": "Chat",
  "chat.switchConversation.title": "Mudar conversa (ativa: {title})",
  "conversation.none": "nenhuma",
  "conversation.empty": "Sem conversas ainda.",
  "conversation.new": "+ Nova conversa",
  "conversation.dirty.title": "Transcrição por gravar (persistência em S9.6-007)",
  "conversation.dirty.clean": "Limpa",
  "conversation.switch.title": "Mudar · duplo clique para renomear",
  "conversation.tokenbar.title": "{pct}% do orçamento usado",
  "conversation.meta": "{n} src · {m} apv",
  "conversation.rename.aria": "Renomear conversa",
  "conversation.delete.aria": "Eliminar conversa",
  "dock.chat.title": "AI Chat",
  "dock.dockTitle": "Encaixar painel",
  "dock.collapseTitle": "Recolher para pílula",
  "dock.floatingDesc": "Painel flutuante {title}",
  "dock.resizeTitle": "Redimensionar {title}",
  "dock.expandTitle": "Expandir {title}",
  "objectTree.label": "Árvore de objetos",
  "objectTree.title": "Objetos",
  "objectTree.loading": "A carregar cena…",
  "objectTree.empty": "Sem objetos.",
  "objectTree.columns.aria": "Colunas de objetos",
  "objectTree.sortName.title": "Ordenar por nome",
  "objectTree.sortName": "Nome",
  "objectTree.col.centerX": "Centro X (mm)",
  "objectTree.col.centerY": "Centro Y (mm)",
  "objectTree.col.centerZ": "Centro Z (mm)",
  "objectTree.col.footprint": "Pegada (w × d)",
  "objectTree.col.volume": "Volume",
  "objectTree.col.footprintShort": "Peg",
  "objectTree.col.volumeShort": "Vol",
  "objectTree.hide": "Ocultar",
  "objectTree.show": "Mostrar",
  "objectTree.hideObj": "Ocultar objeto",
  "objectTree.showObj": "Mostrar objeto",
  "objectTree.unlock": "Desbloquear",
  "objectTree.unlockObj": "Desbloquear objeto",
  "objectTree.lock": "Bloquear",
  "objectTree.lockObj": "Bloquear objeto",
  "objectTree.rename.aria": "Renomear objeto",
  "objectTree.provenance": "{name} — {provenance}",
  "objectTree.repair.title": "Não estanque — clique para Auto-reparar",
  "objectTree.repair.label": "Auto-reparar {name}",
  "objectTree.repair": "reparar",
  "objectTree.mesh.aria": "Estatísticas de malha",
  "objectTree.placement.aria": "Métricas de colocação",
  "objectTree.menu.title": "Menu de objeto",
  "objectTree.menu.aria": "Ações para {name}",
  "objectTree.add.title": "Adicionar objeto (importação)",
  "objectTree.add": "Adicionar",
  "objectTree.duplicate.title": "Duplicar selecionados",
  "objectTree.delete.title": "Eliminar selecionados",
  "objectTree.arrange.title": "Arrumar",
  "objectTree.toast.repair.title": "Auto-reparar",
  "objectTree.toast.repair.watertight": "{name} está estanque{target}.",
  "objectTree.toast.repair.bridgeError": "Erro de bridge durante a reparação.",
  "objectTree.toast.repair.asCopy": ' como "{object}"',
  "objectSettings.label": "Definições de impressão do objeto",
  "objectSettings.title": "Definições do objeto",
  "objectSettings.selectHint":
    "Selecione um objeto para substituir as definições de impressão ou atribuir um filamento.",
  "objectSettings.mode.overridden": "Substituído — este objeto não usa o rascunho global.",
  "objectSettings.mode.global": "Usando global — o objeto herda o rascunho de impressão global.",
  "objectSettings.resetParent": "Repor para o pai",
  "objectSettings.override": "Substituir definições",
  "objectSettings.filament": "Filamento",
  "objectSettings.filament.global": "Global",
  "objectSettings.forkedValues": "Valores derivados",
  "objectSettings.field.layerHeight": "Altura de camada",
  "objectSettings.field.lineWidth": "Largura de linha",
  "objectSettings.field.nozzle": "Bico",
  "objectSettings.field.wallLoops": "Voltas de parede",
  "objectSettings.field.topBottom": "Camadas superior/inferior",
  "objectSettings.field.infillDensity": "Densidade de preenchimento",
  "objectSettings.field.nozzleTemp": "Temp. do bico",
  "objectSettings.field.bedTemp": "Temp. da cama",
  "objectSettings.field.partFan": "Ventoinha da peça",
  "objectSettings.field.printSpeed": "Velocidade de impressão",
  "settings.aria": "Definições de corte",
  "settings.heading": "Definições de impressão",
  "settings.draftBadge": "Rascunho",
  "settings.tabs.aria": "Categoria de definições",
  "settings.tabs.printer": "Impressora",
  "settings.tabs.filament": "Filamento",
  "settings.tabs.process": "Processo",
  "settings.language": "Idioma",
  "settings.language.hint": "Idioma da interface — muda ao vivo.",
  "settings.presets": "Predefinições",
  "settings.printerProfile": "Perfil de impressora",
  "settings.qualityPreset": "Predefinição de qualidade",
  "settings.customLayerHeight": "Altura de camada personalizada",
  "settings.machine": "Máquina",
  "settings.selectPrinter": "Selecionar impressora",
  "settings.plateVolume": "{w} x {d} x {h} mm",
  "settings.noProfile": "Nenhum perfil de impressora selecionado",
  "settings.nozzleDiameter": "Diâmetro do bico",
  "settings.motionCapabilities": "Capacidades de movimento",
  "settings.continuousZ": "Z contínuo",
  "settings.continuousZ.unknown": "Desconhecido",
  "settings.continuousZ.supported": "Suportado",
  "settings.continuousZ.unsupported": "Não suportado",
  "settings.source.operator": "Origem: declaração do operador",
  "settings.source.undeclared": "Capacidade ainda não declarada",
  "settings.filament": "Filamento",
  "settings.activeColor": "Ativo: {color}",
  "settings.material": "Material",
  "settings.materialType": "Tipo",
  "settings.diameter": "Diâmetro",
  "settings.temperature": "Temperatura",
  "settings.nozzle": "Bico",
  "settings.bed": "Cama",
  "settings.cooling": "Arrefecimento",
  "settings.partFan": "Ventoinha da peça",
  "settings.quality": "Qualidade",
  "settings.strength": "Resistência",
  "settings.topBottom": "Camadas superior / inferior",
  "settings.infillPattern": "Padrão de preenchimento",
  "settings.infill.grid": "Grelha",
  "settings.infill.gyroid": "Subconjunto gyroid",
  "settings.speed": "Velocidade",
  "settings.print": "Impressão",
  "settings.travel": "Deslocamento",
  "settings.supportAdhesion": "Suporte & adesão",
  "settings.generateSupports": "Gerar suportes",
  "settings.brim": "Brim",
  "settings.supports.on": "Suportes",
  "settings.supports.off": "Sem suportes",
  "settings.supports.brimSuffix": " · brim",
  "settings.supports.summaryTail": " — aplicado no corte, controlado pelo pré-fluxo estanque.",
  "settings.notEligible": "Ainda não elegível — os objetos na placa têm de ser estanques.",
  "settings.draftNote": "Parâmetros de rascunho. Percursos existentes não são alterados.",
  "settings.export": "Exportar definições",
  "settings.layerHeight": "Altura de camada",
  "settings.lineWidth": "Largura de linha",
  "settings.wallLoops": "Voltas de parede",
  "settings.infillDensity": "Densidade de preenchimento",
  "settings.applyPresetToast": "Predefinição aplicada ao rascunho",
  "timeline.label": "Linha de tempo e corte",
  "timeline.journal.aria": "Diário de transformações",
  "timeline.undo": "Desfazer",
  "timeline.undo.title": "Desfazer (Ctrl+Z)",
  "timeline.redo": "Refazer",
  "timeline.redo.title": "Refazer (Ctrl+Shift+Z / Ctrl+Y)",
  "timeline.seek.title": "Saltar para a revisão {n}",
  "timeline.events.aria": "Eventos em {rev}",
  "timeline.slicing.title": "Modo de corte",
  "timeline.slicing.label": "Modo de corte",
  "slicing.mode.standard": "Standard (planar)",
  "slicing.mode.nonplanar": "Não planar (experimental)",
  "timeline.nonplanar.blocked":
    "Z contínuo declarado não suportado. Percursos importados permanecem visíveis.",
  "timeline.nonplanar.supported": "Z contínuo suportado",
  "timeline.nonplanar.undeclared": "Z contínuo ainda não declarado",
  "timeline.nonplanar.operator": " (operador)",
  "timeline.nonplanar.enabled":
    "Edição não planar ativada; geração de impressão aguarda validação.",
  "timeline.menu.seek": "Saltar para a revisão {revision}",
  "timeline.menu.resetHead": "Repor para o topo do diário",
  "transform.label": "Inspetor de transformação",
  "transform.title": "Transformação",
  "transform.emptyHint": "Selecione um objeto para editar peças, posição e escala.",
  "transform.abs": "abs",
  "transform.rel": "rel",
  "transform.mode.relative": "Modo relativo",
  "transform.mode.absolute": "Modo absoluto",
  "transform.mode.title": "{mode} — deltas para posição/rotação, fatores para escala",
  "transform.copy.title": "Copiar valor X para Y e Z",
  "transform.copy.label": "Copiar {kind} X para Y e Z",
  "transform.reset.title": "Repor {kind} para {n}",
  "transform.reset.label": "Repor {kind}",
  "transform.axis.label": "{kind} {axis}",
  "transform.kind.position": "posição",
  "transform.kind.rotation": "rotação",
  "transform.kind.scale": "escala",
  "transform.warning.nonUniform":
    "Escala não uniforme — paredes finas podem imprimir mal. Considere repor a escala para 1:1:1.",
  "transform.note.resized": "Escala alterada da identidade.",
  "transform.toast.rejected.title": "Transformação rejeitada",
  "transform.toast.failed": "Falha de transformação",
  "transform.toast.invalid.title": "Valor inválido",
  "transform.toast.invalid.message": "Entrada numérica esperada.",
  "boolean.label": "Ferramenta booleana",
  "boolean.title": "Booleana",
  "boolean.arm": "Armar",
  "boolean.armed": "Armada",
  "boolean.arm.label": "Armar ferramenta booleana",
  "boolean.arm.hint": "Arme a ferramenta booleana para combinar dois objetos.",
  "boolean.operation": "Operação",
  "boolean.op.union": "União",
  "boolean.op.subtract": "Subtração",
  "boolean.op.intersect": "Interseção",
  "boolean.objectA": "Objeto A",
  "boolean.objectB": "Objeto B",
  "boolean.selectA": "Selecionar A…",
  "boolean.selectB": "Selecionar B…",
  "boolean.preview.template":
    "Pré-visualização: {name} · {tri} tri · estanque (limites {min}…{max} mm)",
  "boolean.preview.pick": "Escolha dois objetos estanques distintos para pré-visualizar.",
  "boolean.hideSources": "Ocultar objetos de origem",
  "boolean.execute": "Executar {op}",
  "boolean.committed":
    "Confirmado — “{name}” foi adicionado à cena (proveniência anotada, seguro para diário).",
  "boolean.toast.warning.title": "Booleana",
  "boolean.toast.warning.message": "Escolha primeiro dois objetos estanques distintos.",
  "boolean.toast.done": "Booleana {verb}",
  "boolean.toast.sourcesHidden": "Origens ocultas.",
  "boolean.toast.sourcesKept": "Origens mantidas.",
  "measure.kind.label": "Tipo de medição",
  "measure.kind.distance": "Dist",
  "measure.kind.radius": "R",
  "measure.kind.angle": "∠",
  "measure.prompt.distance": "Escolha o primeiro ponto",
  "measure.prompt.radius": "Escolha 3 pontos numa aresta circular",
  "measure.prompt.angle": "Escolha o vértice e depois duas arestas",
  "measure.pts": "{n}/{need} pts",
  "measure.pending": "{pending} — {prompt}",
  "measure.clear.aria": "Limpar medição",
  "measure.clear": "limpar",
  "viewport.preview.mode": "modo: {mode}",
  "viewport.preview.layerOf": "Camada {n} de {total}",
  "viewport.preview.walls": "Paredes",
  "viewport.preview.infill": "Preenchimento",
  "viewport.repairLabel": "Precisa de reparação:",
  "viewport.dropHint": "Solte para importar",
  "viewport.menu.arrange": "Arrumar objetos",
  "viewport.menu.measure": "Medir",
  "viewport.menu.import": "Importar…",
  "viewport.toast.arrange.title": "Arrumar",
  "viewport.toast.arrange.message":
    "Use a barra de ferramentas Arrumar para empacotamento de prateleira.",
  "viewport.toast.measure.title": "Medir",
  "viewport.toast.measure.message": "A ferramenta Medir chega numa sprint posterior.",
  "viewCube.aria": "Cubo de vista",
  "viewCube.home": "Isométrica (início)",
  "viewCube.face": "Ver face {face}",
  "viewCube.corner": "Canto isométrico",
  "labels.note.watertight": "estanque",
  "labels.note.repair": "precisa de reparação",
  "labels.note.locked": "bloqueado",
  "plateTabs.aria": "Placas",
  "plateTabs.unsaved": "{name} · por gravar",
  "plateTabs.add.aria": "Adicionar placa",
  "plateTabs.add.title": "Adicionar placa",
  "plateTabs.unsavedDot": "Alterações por gravar",
  "menu.duplicate": "Duplicar",
  "menu.rename": "Renomear",
  "menu.hide": "Ocultar",
  "menu.show": "Mostrar",
  "menu.placeOnPlate": "Colocar na placa",
  "menu.repairReplace": "Auto-reparar (substituir)",
  "menu.repairCopy": "Auto-reparar (cópia)",
  "menu.delete": "Eliminar",
  "menu.plate.duplicate": "Duplicar placa",
  "menu.plate.rename": "Renomear…",
  "menu.plate.moveHeader": "Mover objetos para…",
  "shortcut.tool.select": "Selecionar",
  "shortcut.tool.move": "Mover",
  "shortcut.tool.rotate": "Rodar",
  "shortcut.tool.scale": "Escalar",
  "shortcut.view.fit": "Enquadrar vista",
  "shortcut.view.iso": "Vista isométrica",
  "shortcut.view.top": "Vista superior",
  "shortcut.view.front": "Vista frontal",
  "shortcut.view.right": "Vista direita",
  "shortcut.edit.undo": "Desfazer",
  "shortcut.edit.redo": "Refazer",
  "shortcut.object.duplicate": "Duplicar",
  "shortcut.object.delete": "Eliminar",
  "shortcut.measure.toggle": "Medir",
  "shortcut.snap.toggle": "Snap",
  "shortcut.grid.toggle": "Grelha",
  "shortcut.object.grabMove": "Mover (agarrar)",
  "shortcut.object.grabRotate": "Rodar (agarrar)",
  "shortcut.object.grabScale": "Escalar (agarrar)",
  "shortcut.object.constrainAxis": "Restringir eixo",
  "shortcut.object.grabConfirm": "Confirmar agarrar",
  "shortcut.object.grabCancel": "Cancelar agarrar",
  "shortcut.edit.redoShift": "Refazer (shift)",
  "shortcut.help.frame": "Enquadrar seleção",
  "shortcut.help.toolSwitch": "Selecionar / Mover / Rodar / Escalar",
  "shortcut.group.transform": "Transformação",
  "shortcut.group.tools": "Ferramentas",
  "shortcut.group.scene": "Cena",
  "shortcut.group.edit": "Editar",
  "contextMenu.aria": "Menu de contexto",
  "send.token.title": "Token hash — fixa o payload aprovado exato",
  "send.payloadChanged": "payload alterado desde a aprovação",
  "send.task": "tarefa {id}",
  "send.sendBlocked": "Envio bloqueado",
  "send.approveCardFirst": "aprove o cartão primeiro",
  "send.payloadChangedMessage": "payload alterado — aprove novamente",
  "send.offline.title": "Impressora offline",
  "send.sendFailed": "Falha de envio",
  "send.printerOffline": "Impressora offline",
  "send.jobSent.title": "Trabalho de impressão enviado",
  "send.jobSent.message": "{name} · {taskId}",
  "send.sendTitle": "Enviar para impressão",
  "send.sendToPrinter": "Enviar para impressora",
  "send.stage.negotiate": "A negociar com a impressora…",
  "send.stage.upload": "A enviar corte…",
  "send.stage.queue": "A colocar em fila…",
  "send.reject": "Rejeitar",
  "send.approve": "Aprovar",
  "send.dismiss": "Dispensar",
  "common.cancel": "Cancelar",
  "common.undo": "Desfazer",
  "common.redo": "Refazer",
  "common.empty": "",
};

/** Locale → table (the store reads this map; EN is the canonical key source). */
export const STRINGS: Record<Locale, Record<MsgKey, string>> = {
  en: EN,
  "pt-BR": PT_BR,
};

/** Interpolate `{token}` placeholders in a translated template. Unknown
 * tokens are left as-is (never stripped — malformed keys stay visible). */
export function interpolate(template: string, params?: Readonly<Record<string, string>>): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    return Object.prototype.hasOwnProperty.call(params, name) ? params[name]! : match;
  });
}

/** EN vs PT-BR key-set parity — the unit tests + the store boot enforce it. */
export function localeKeysMatch(
  en: Readonly<Record<string, string>>,
  pt: Readonly<Record<string, string>>,
): boolean {
  const enKeys = Object.keys(en);
  const ptKeys = new Set(Object.keys(pt));
  return enKeys.length === ptKeys.size && enKeys.every((k) => ptKeys.has(k));
}

/** Plural-aware tail: EN "object"/"objects", PT "objeto"/"objetos". */
export function pluralTail(locale: Locale, n: number): string {
  const s = n === 1 ? "" : "s";
  return locale === "pt-BR" ? (n === 1 ? "o" : "os") : s;
}

/** Gender/dirty variant helper for the status-bars (EN `object(s)`, PT
 * `objeto(s)` — the plural suffix adapts). */
export function pluralObjects(locale: Locale, n: number): string {
  return locale === "pt-BR" ? (n === 1 ? "objeto" : "objetos") : n === 1 ? "object" : "objects";
}
