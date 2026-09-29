import { useCallback, useEffect, useState } from "react";
import type { OperatorProfile } from "./operatorProfile";
import { defaultOperatorProfile } from "./operatorProfile";

const STORAGE_KEY = "anycubic-bridge.operator-profile.v1";

function isOperatorProfile(value: unknown): value is OperatorProfile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.displayName === "string" &&
    typeof v.continuousZ === "string" &&
    typeof v.provenance === "string"
  );
}

function readStoredProfile(): OperatorProfile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return defaultOperatorProfile();
    const parsed: unknown = JSON.parse(raw);
    if (!isOperatorProfile(parsed)) return defaultOperatorProfile();
    return { ...defaultOperatorProfile(), ...parsed };
  } catch {
    return defaultOperatorProfile();
  }
}

export function useOperatorProfile(): readonly [
  OperatorProfile,
  (profile: OperatorProfile) => void,
] {
  const [profile, setProfile] = useState<OperatorProfile>(readStoredProfile);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {
      // Persistence is best-effort; the in-memory state remains authoritative.
    }
  }, [profile]);
  const update = useCallback((next: OperatorProfile) => setProfile(next), []);
  return [profile, update] as const;
}
