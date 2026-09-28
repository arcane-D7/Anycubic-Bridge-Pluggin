# Pre-fabrication validation checklist

Work through this before telling a user a part is ready to fabricate. Each item names the failure
it catches, because a checklist without consequences gets skipped.

## 1. Provenance

- [ ] The STEP was produced by `gen.py` from the current model source.
      _Catches: a stale artifact that no longer matches the code you just edited._
- [ ] A `*.manifest.json` exists alongside it, and its `source.sha256` matches the model file.
      _Catches: silently editing an exported STEP, which makes the design unreproducible._
- [ ] The manifest's `interfaces` block lists every dimension a bundled standard covers, and its
      values are the ones the model computed after any `--param` override. Empty is correct only
      when nothing on the part mates with a bundled standard — and then every interface dimension
      is named as unchecked in the report instead.
      _Catches: a static `INTERFACES` list frozen at import, recording pre-override numbers; and
      an interface that silently escaped checking._
- [ ] Every parameter in the model is named with units.
      _Catches: the bare `12.7` nobody can later identify as half an inch._

```bash
python scripts/gen.py part_model.py --outdir out/
```

## 2. Geometry is sound

- [ ] `is_valid` is true.
      _Catches: self-intersecting or non-manifold solids that slicers and CAM silently mangle._
- [ ] `solid_count` is what you expect — usually 1.
      _Catches: a boolean that failed and left two disjoint lumps, or a feature floating free of
      the body._
- [ ] Volume is plausible for the part's size and wall thickness.
      _Catches: a cavity modelled solid, or a subtract that did nothing._
- [ ] Every geometric requirement in the request is declared in `checks()` and passes — clear
      regions for what must pass through or fit in, material regions for what must remain,
      bbox bounds for stated size limits.
      _Catches: a recess that swallowed its screw seat, a pocket the mating part cannot enter,
      a beam corridor with a wall in it, a feature a fillet silently ate — all invisible to
      `is_valid` and the bounding box._

```bash
python scripts/check.py facts out/part.step
python scripts/check.py geometry out/part.step --model part_model.py
```

## 3. Interfaces

- [ ] Every interface dimension has a written source: a standard ID, a vendor drawing, or a user
      measurement. **None came from memory.**
      _Catches: the single most expensive failure mode in this skill._
- [ ] Every interface covered by a standard is declared in the model's `interfaces()` and passes
      `check.py interfaces`.
      _Catches: an interface nobody checked because the outer bounding box could not see it._
- [ ] Features that receive a standardised component use `intent: "envelope"`.
      _Catches: a pocket sized to nominal, which fits only the smaller half of conforming parts._
- [ ] Any standard entry marked `verified: false` was confirmed against the primary document, or
      the user was told it is unconfirmed.
      _Catches: propagating a derived number as if it were read from the standard._
- [ ] Metric vs imperial is confirmed where both exist, and no expression mixes them.
      _Catches: the 25.0 vs 25.4 mm grid error, which accumulates to 1.6 mm over four holes._
- [ ] Interfaces not covered by any bundled standard — a vendor drawing, a measurement — were
      reported to the user as unchecked, with the number and its source.
      _Catches: a silent gap where the automatic check simply had nothing to say._

```bash
python scripts/check.py interfaces out/part.manifest.json

# one dimension by hand, when it is not declared in the model
python scripts/check.py fit --standard <id> --intent envelope --clearance <mm> --value <dim>=<mm>
```

## 4. Fits and assembly

- [ ] Every mating dimension has a deliberate clearance chosen for the process.
      _Catches: nominal-to-nominal fits, which do not assemble._
- [ ] Multi-part assemblies were checked for interference.
      _Catches: parts that overlap in CAD and therefore cannot exist together._
- [ ] Rigid multi-hole mounting patterns have at least one slot.
      _Catches: a four-hole bolt pattern binding on accumulated tolerance._

```bash
python scripts/check.py clearance out/a.step out/b.step --min 0.3
```

## 5. Manufacturability

- [ ] Minimum wall and feature sizes are within the chosen process (`fabrication-limits.md`).
- [ ] Print or machining orientation is stated, and load runs along layers, not across them.
- [ ] Threads use inserts or captive nuts rather than printed threads, unless coarse.
- [ ] Enclosed cavities have a drain path for resin, and support-free access where possible.
- [ ] Milled internal corners have relief for the tool radius.

## 6. Material

- [ ] Material is compatible with the **cleaning agent**, not only the sample.
      _Catches: acrylic crazing on 70% ethanol; PLA distorting in an autoclave._
- [ ] Sterilisation method is stated and the material actually survives it.
- [ ] Anything contacting cells, tissue, or animals has a justified material, or contact is
      designed out.
      _Catches: assuming a printed resin part is cell-safe._
- [ ] Optical requirements — autofluorescence, scatter, transmission — are addressed if the part is
      near a beam or a detector.

## 7. Visual review — mandatory

- [ ] A snapshot was rendered **and read** after the most recent generation.
- [ ] Confirmed in the image: features on the intended faces; correct mold/chip polarity; every
      port, bore, and boss present, inside the body, and passing through; nothing consumed by a
      fillet; clear apertures unobstructed.

```bash
python scripts/snapshot.py out/part.step --out out/part.png
```

**This step is never waived by the numeric checks passing.** `is_valid: true` with a correct
bounding box is fully consistent with a pocket cut on the wrong face or an inverted mold. Those
errors are obvious in the picture and invisible in the numbers.

## 8. Report

Give the user, explicitly:

1. Process and material, and why.
2. Every interface dimension with its source and tolerance.
3. Clearances chosen, and the fit class they came from.
4. What the snapshot showed — described, not merely "a snapshot was generated".
5. Every check that did not pass, and every dimension you could not verify.
6. A recommendation to print a test coupon of the critical interface before committing to the full
   part, whenever the design depends on a fit.

State the unverified items plainly. A part list with one honest "this dimension needs
confirmation" is far more useful than a confident one that is silently wrong.
