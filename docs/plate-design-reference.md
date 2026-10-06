# Build Plate Design Reference — Real Commercial Plates

> Reference portfolio for the realistic build plate modelled in
> `apps/editor/src/viewport/BuildPlate.tsx` (S9.10-002, pass-4).
>
> Purpose: keep the 3D plate visually grounded in real double-sided PEI /
> textured plates sold with popular FDM machines. This is a DESIGN glossary —
> public product names and observable design traits only (no serials, no
> account data, no per-machine values). Nothing here is hardware-verified
> protocol data.

---

## 1. Design vocabulary (what the model reproduces)

| Real plate trait                                               | Our model (BuildPlate.tsx)                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Perforated/beaded **outer rim** around the sheet               | `OUTER FRAME` — `FRAME_THICKNESS = 0.9`, top at y=0                 |
| **Printable area** recessed from the rim                       | `INNER PRINT AREA` — `TOP_THICKNESS = 0.8`, inset `FRAME_INSET = 6` |
| **Corner locator holes** (alignment pins seat here)            | engraved cylinders at the area corners (`drawer` inset)             |
| **Rear locating tab**                                          | thin rounded tab at `z = halfD + 3`                                 |
| **Grid** stops at the sheet border (never over the lapped rim) | minor/major lines clipped to `halfWidth/halfDepth - FRAME_INSET`    |
| Engraved **brand row** on one edge                             | `ANYCUBIC · S1` at `z = -areaD/2 - 2.4`                             |
| Centered **specs** row                                         | `{W} × {D} × {H} mm` at center                                      |
| **Material / side** label + front arrow                        | `PEI · DOUBLE-SIDED` at `z = areaD/2 + 2.4`, front arrow tick at +Z |

## 2. Plate families observed in the wild (public listings)

> Agnostic names — treat as a style catalogue, not a spec sheet.

### A. Bambu Lab family

- **Bambu Textured PEI Plate** — matte dark surface, large beaded rim,
  "Bambu Lab" + serial engraving on the front tab; grid/rim contrast high.
- **Bambu Cool Plate** — smooth glossy (PETG-friendly); rear handle tab,
  minimal engraving, larger locator pins.
- **Bambu High-Temp Plate** — semi-gloss; strong corner pin seats, small
  center "HIGH-TEMP" text.
- **Bambu Engineering Plate** — light matte; big brand block + belt notches.

### B. Anycubic family

- **Anycubic Kobra / Kobra 2 PEI plate** (S1/S2 MonoX-style sheets) — dark
  textured PEI, thin beaded rim, corner locators, engraved "KOBRA" row near
  the +Y edge, rear tab.
- **Anycubic UltraBase (Vyper/Neo)** — smooth dark base + printed grid
  markers; rim mostly flush, no tall frame.
- **Anycubic resin-style magnetic beds** (older) — plain, no frame; out of
  scope for our FDM sheet model.

### C. Prusa / generic

- **Prusa textured PEI sheet** — walnut-grain texture, generous frame,
  engraved "Prusa" small at the front-left; grid starts after a safe margin.
- **Generic double-sided PEI (EU/US sellers)** — the "9-sheet grid",
  "corner PIN" and "rear tab" conventions are shared across brands.

## 3. Traits the common plates share (why the model looks the way it does)

1. **Sheet thinner than it looks** — real spring-steel+PEI sheets are ~0.8-1 mm;
   the perceived thickness comes from the beaded rim. (Our regression fix:
   `RoundedBox radius ≤ half-thickness`, else the geometry bloats.)
2. **Printable area < physical footprint** — the rim/label lane is real
   millimeter territory, typically 3-8 mm per side.
3. **Grid is a print aid, not a ruler** — starts/ends cleanly at the sheet
   boundary; minor ~10 mm, major ~50 mm is the common convention.
4. **Orientation markers** — a front arrow/tick or notch tells the operator
   which edge is "front"; the +Z edge convention matches Quadrants.
5. **Markings are engraved, not plated** — lower contrast than the sheet
   itself; brand row, spec row, material row, and a small front arrow.

## 4. Future swap-in portfolio (image assets)

When real photos become available (screen-captured from the slicer or手机
product pages, redacted per repo rules), add them under `docs/evidence/` and
reference them from this table:

| Family    | Model          | Key visual                | Where it would teach us   |
| --------- | -------------- | ------------------------- | ------------------------- |
| Bambu Lab | Textured PEI   | beaded rim + tab          | rim vs area contrast      |
| Bambu Lab | Cool Plate     | glossy smooth             | clearcoat/metalness range |
| Anycubic  | Kobra PEI      | dark textured + brand row | engraving placement       |
| Prusa     | Textured sheet | grain + safe grid margin  | grid inset logic          |

> Redaction rule: any future screenshot must be scrubbed of serial numbers,
> MAC/IP, account ids and printer ids before landing in `docs/evidence/`
> (`scripts/redact-evidence-json.mjs` guards JSON; images need manual crop).
