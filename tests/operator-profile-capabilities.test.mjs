import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function srcUrl(...segments) {
  return pathToFileURL(path.join(root, "apps", "editor", "src", ...segments)).href;
}

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const { resolveContinuousZCapability, resolveNonPlanarEligibility, isSlopeWithinBudget } =
  await import(srcUrl("profile", "capabilities.ts"));
const {
  defaultOperatorProfile,
  withCatalogSelection,
  withContinuousZDeclaration,
  clearContinuousZDeclaration,
  validateBuildVolume,
  catalogMachineById,
  CATALOG_MACHINES,
} = await import(srcUrl("profile", "operatorProfile.ts"));

test("unknown capability is distinct from explicitly unsupported (no profile)", () => {
  const cap = resolveContinuousZCapability(null, null);
  assert.equal(cap.status, "unknown");
  assert.notEqual(cap.status, "unsupported");
  assert.match(cap.explanation, /not loaded/i);
});

test("absent token in a loaded profile is unknown, not unsupported", () => {
  const cap = resolveContinuousZCapability(["planar", "nozzle-0.4"], null);
  assert.equal(cap.status, "unknown");
  assert.match(cap.explanation, /unknown, not unsupported/i);
});

test("explicit negative token marks unsupported with profile provenance", () => {
  const cap = resolveContinuousZCapability(["planar", "no-continuous-z"], null);
  assert.equal(cap.status, "unsupported");
  assert.equal(cap.source, "profile-declared");
});

test("profile-declared support stays distinct from operator-declared support", () => {
  const profileCap = resolveContinuousZCapability(["continuous-z"], null);
  assert.equal(profileCap.status, "supported");
  assert.equal(profileCap.source, "profile-declared");

  const operator = withContinuousZDeclaration(defaultOperatorProfile(), "supported");
  const operatorCap = resolveContinuousZCapability(["planar"], operator);
  assert.equal(operatorCap.status, "supported");
  assert.equal(operatorCap.source, "operator-declared");
});

test("operator unsupported declaration overrides a profile support token", () => {
  const operator = withContinuousZDeclaration(defaultOperatorProfile(), "unsupported");
  const eligibility = resolveNonPlanarEligibility(["continuous-z"], operator);
  assert.equal(eligibility.capability.status, "unsupported");
  assert.equal(eligibility.canAuthor, false);
  assert.equal(eligibility.authoringState, "blocked");
});

test("unknown profile still allows non-planar authoring with pending qualification", () => {
  const eligibility = resolveNonPlanarEligibility(["planar", "nozzle-0.4"], null);
  assert.equal(eligibility.capability.status, "unknown");
  assert.equal(eligibility.canAuthor, true);
  assert.equal(eligibility.authoringState, "pending-qualification");
  assert.equal(eligibility.printQualified, false);
});

test("authoring non-planar never marks the engine print-qualified for unknown", () => {
  const eligibility = resolveNonPlanarEligibility(null, null);
  assert.equal(eligibility.canAuthor, true);
  assert.equal(eligibility.printQualified, false);
  assert.equal(eligibility.authoringState, "pending-qualification");
});

test("operator-declared support does not qualify printing (pending until verified)", () => {
  const operator = withContinuousZDeclaration(defaultOperatorProfile(), "supported", {
    slopeBudgetDeg: 45,
  });
  const eligibility = resolveNonPlanarEligibility(["planar"], operator);
  assert.equal(eligibility.capability.source, "operator-declared");
  assert.equal(eligibility.canAuthor, true);
  assert.equal(eligibility.printQualified, false);
  assert.equal(eligibility.slopeBudgetDeg, 45);
});

test("profile-declared support token never qualifies printing (regression)", () => {
  const canonical = resolveNonPlanarEligibility(["continuous_z"], null);
  assert.equal(canonical.capability.status, "supported");
  assert.equal(canonical.capability.source, "profile-declared");
  assert.equal(canonical.canAuthor, true);
  assert.equal(canonical.printQualified, false);
  assert.equal(canonical.authoringState, "pending-qualification");

  const legacy = resolveNonPlanarEligibility(["continuous-z"], null);
  assert.equal(legacy.capability.status, "supported");
  assert.equal(legacy.capability.source, "profile-declared");
  assert.equal(legacy.printQualified, false);
  assert.equal(legacy.authoringState, "pending-qualification");
});

test("slope and joint values alone are not proof of print qualification", () => {
  const operator = withContinuousZDeclaration(defaultOperatorProfile(), "supported", {
    slopeBudgetDeg: 45,
    jointModel: "cartesian",
  });
  const withToken = resolveNonPlanarEligibility(["continuous_z"], operator);
  assert.equal(withToken.capability.source, "operator-declared");
  assert.equal(withToken.slopeBudgetDeg, 45);
  assert.equal(withToken.canAuthor, true);
  assert.equal(withToken.printQualified, false);
  assert.equal(withToken.authoringState, "pending-qualification");

  const withoutToken = resolveNonPlanarEligibility(["planar"], operator);
  assert.equal(withoutToken.capability.source, "operator-declared");
  assert.equal(withoutToken.slopeBudgetDeg, 45);
  assert.equal(withoutToken.printQualified, false);
  assert.equal(withoutToken.authoringState, "pending-qualification");
});

test("operator declaration preserves source and unqualified slopes on supported", () => {
  const operator = withContinuousZDeclaration(defaultOperatorProfile(), "supported");
  assert.equal(operator.continuousZ, "supported");
  assert.equal(operator.provenance, "operator-declared");
  assert.equal(operator.slopeBudgetDeg, null);
  assert.equal(operator.jointModel, null);
});

test("clearing a declaration returns to unknown with unknown provenance", () => {
  const declared = withContinuousZDeclaration(defaultOperatorProfile(), "supported", {
    slopeBudgetDeg: 30,
    jointModel: "cartesian",
  });
  const cleared = clearContinuousZDeclaration(declared);
  assert.equal(cleared.continuousZ, "unknown");
  assert.equal(cleared.provenance, "unknown");
  assert.equal(cleared.slopeBudgetDeg, null);
  assert.equal(cleared.jointModel, null);
});

test("catalog selection sets official Kobra S1 volume but leaves continuousZ unknown", () => {
  const machine = catalogMachineById("kobra-s1");
  assert.ok(machine !== null);
  assert.deepEqual(machine.buildVolume, { widthMm: 250, depthMm: 250, heightMm: 250 });

  const selected = withCatalogSelection(defaultOperatorProfile(), "kobra-s1");
  assert.equal(selected.displayName, "Anycubic Kobra S1");
  assert.deepEqual(selected.buildVolume, { widthMm: 250, depthMm: 250, heightMm: 250 });
  assert.equal(selected.continuousZ, "unknown");
  assert.equal(selected.provenance, "unknown");
});

test("catalog defaults never hardcode operator support as manufacturer fact", () => {
  for (const machine of CATALOG_MACHINES) {
    const selected = withCatalogSelection(defaultOperatorProfile(), machine.id);
    assert.equal(selected.continuousZ, "unknown");
    assert.equal(selected.provenance, "unknown");
  }
});

test("unknown catalog id leaves the profile untouched", () => {
  const profile = defaultOperatorProfile();
  assert.equal(withCatalogSelection(profile, "nonexistent"), profile);
});

test("build volume validation rejects null and non-positive dimensions", () => {
  assert.ok(validateBuildVolume(null).length > 0);
  assert.equal(validateBuildVolume({ widthMm: 250, depthMm: 250, heightMm: 250 }).length, 0);
  const bad = validateBuildVolume({ widthMm: 0, depthMm: -1, heightMm: Number.NaN });
  assert.equal(bad.length, 3);
  assert.deepEqual(bad.map((i) => i.field).sort(), ["depthMm", "heightMm", "widthMm"]);
});

test("slope budget check returns null when budget is unqualified, false when exceeded", () => {
  assert.equal(isSlopeWithinBudget(30, null), null);
  assert.equal(isSlopeWithinBudget(30, undefined), null);
  assert.equal(isSlopeWithinBudget(Number.NaN, 45), null);
  assert.equal(isSlopeWithinBudget(30, 45), true);
  assert.equal(isSlopeWithinBudget(60, 45), false);
});
