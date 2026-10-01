/**
 * S9.2-005 — Import dialog (STL binary+ASCII / 3MF).
 *
 * Entry point #1 of three (footer Add button; the other two are drag-drop
 * onto the viewport and the file dialog trigger inside this dialog). The
 * dialog:
 *
 *   - opens a hidden file input (accept .stl,.3mf) via the footer Add button,
 *   - lets the user toggle scale/center/orient-flat (defaults ON),
 *   - parses the file with `bridge/import.ts` (pure, no three.js),
 *   - normalizes via `import-core.prepareImportedObject` → scene payload,
 *   - derives a UNIQUE object name against the current store graph,
 *   - persists through the bridge CRUD lane (`scene.mutateObject` add),
 *     hydrates the store, then invalidates the authoritative scene query.
 *
 * Imported objects land in the store + bridge immediately with watertight
 * status computed (AC-2: "appears in tree + viewport immediately").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeHandle } from "../bridge/mock";
import { parseStl, parseThreemf, type TriangleBuffers } from "../bridge/import";
import {
  classifyFile,
  DEFAULT_IMPORT_FLAGS,
  fitFactor,
  type ImportOptions,
} from "../bridge/import-core";
import { useImportCommit } from "../bridge/import-actions";
import { useI18n } from "../state/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Icon } from "../components/icons";

interface ImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly scene: BridgeHandle | undefined;
}

export function ImportDialog({ open, onOpenChange, scene }: ImportDialogProps) {
  const { commitFile } = useImportCommit(scene);
  const t = useI18n((s) => s.t);
  const inputRef = useRef<HTMLInputElement>(null);

  const [flags, setFlags] = useState({ ...DEFAULT_IMPORT_FLAGS });
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    readonly triangles: number;
    readonly vertices: number;
    readonly sizeMm: readonly [number, number, number];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // parsed mesh bounds (kept for the scale auto-fit factor).
  const [parsedBounds, setParsedBounds] = useState<TriangleBuffers["bounds"] | null>(null);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setFileName(null);
    setPreview(null);
    setError(null);
    setFlags({ ...DEFAULT_IMPORT_FLAGS });
    setParsedBounds(null);
  }, [open]);

  const onFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      const kind = classifyFile(file.name);
      if (!kind) {
        setError(t("import.unsupported", { name: file.name }));
        return;
      }
      setBusy(true);
      setError(null);
      setFileName(file.name);
      void (async () => {
        try {
          const buffer = await file.arrayBuffer();
          const parsed: TriangleBuffers =
            kind === "stl" ? parseStl(buffer, file.name) : parseThreemf(buffer, file.name);
          setParsedBounds(parsed.bounds);
          setPreview({
            triangles: parsed.triangleCount,
            vertices: parsed.vertexCount,
            sizeMm: [
              parsed.bounds.max[0] - parsed.bounds.min[0],
              parsed.bounds.max[1] - parsed.bounds.min[1],
              parsed.bounds.max[2] - parsed.bounds.min[2],
            ],
          });
        } catch (err) {
          setPreview(null);
          setError(
            err instanceof Error
              ? t("import.failed.message", { err: err.message })
              : t("import.failed.fallback"),
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [t],
  );

  /** Commit the parsed file into the scene graph (shared import-actions path). */
  const onImport = useCallback(async () => {
    const input = inputRef.current;
    const file = input?.files?.[0];
    if (!file || !scene || !fileName) return;
    setBusy(true);
    setError(null);
    const opts: ImportOptions = {
      center: flags.center,
      orientFlat: flags.orientFlat,
      // "Keep units (mm)" ON (default) → scale 1 (no resize). OFF → auto-fit
      // the largest extent to the plate so oversized parts land intact.
      scale: flags.scale ? 1 : parsedBounds ? fitFactor(parsedBounds) : 1,
    };
    const result = await commitFile(file, opts);
    setBusy(false);
    if (result.ok) {
      onOpenChange(false);
    } else {
      setError(result.error ?? t("import.failed.fallback"));
    }
  }, [commitFile, flags, fileName, onOpenChange, parsedBounds, scene, t]);

  const fileLabel = fileName ?? t("import.browse.none");
  const dims = preview
    ? `${preview.sizeMm[0].toFixed(1)} × ${preview.sizeMm[1].toFixed(1)} × ${preview.sizeMm[2].toFixed(1)} mm`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent
        className="import-dialog"
        data-testid="import-dialog"
        // the drag-drop surface covers the whole viewport; the dialog is a
        // contained panel — focus rings stay inside per 9.1a a11y.
      >
        <DialogHeader>
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          accept=".stl,.3mf"
          data-testid="import-file-input"
          className="import-file-input"
          onChange={(e) => onFiles(e.target.files)}
        />
        <button
          type="button"
          data-testid="import-browse"
          className="import-browse"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="folder" size={14} aria-hidden="true" />
          {fileLabel}
        </button>

        {preview ? (
          <dl className="import-preview" data-testid="import-preview">
            <div>
              <dt>{t("import.preview.triangles")}</dt>
              <dd data-testid="import-preview-tris">{preview.triangles.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("import.preview.vertices")}</dt>
              <dd data-testid="import-preview-verts">{preview.vertices.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t("import.preview.size")}</dt>
              <dd className="import-dims" data-testid="import-preview-dims">
                {dims}
              </dd>
            </div>
          </dl>
        ) : null}

        <div className="import-options" aria-label={t("import.options.aria")}>
          <label className="import-option">
            <input
              type="checkbox"
              data-testid="import-option-center"
              checked={flags.center}
              onChange={(e) => setFlags((f) => ({ ...f, center: e.target.checked }))}
            />
            {t("import.option.center")}
          </label>
          <label className="import-option">
            <input
              type="checkbox"
              data-testid="import-option-orient"
              checked={flags.orientFlat}
              onChange={(e) => setFlags((f) => ({ ...f, orientFlat: e.target.checked }))}
            />
            {t("import.option.orientFlat")}
          </label>
          <label className="import-option">
            <input
              type="checkbox"
              data-testid="import-option-scale"
              checked={flags.scale}
              onChange={(e) => setFlags((f) => ({ ...f, scale: e.target.checked }))}
            />
            {t("import.option.keepUnits")}
          </label>
        </div>

        {error ? (
          <p className="import-error" role="alert" data-testid="import-error">
            {error}
          </p>
        ) : null}

        <div className="import-actions">
          <button
            type="button"
            className="import-cancel"
            data-testid="import-cancel"
            onClick={() => onOpenChange(false)}
          >
            {t("import.cancel")}
          </button>
          <button
            type="button"
            className="import-commit"
            data-testid="import-commit"
            disabled={!fileName || busy}
            onClick={() => void onImport()}
          >
            {busy ? t("import.commit.busy") : t("import.commit.idle")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
