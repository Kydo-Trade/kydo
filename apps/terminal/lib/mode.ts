import type { ChainProfile, TraderStatus } from "./chain";
import { isDefaultKey } from "./chain";
import type { Mode } from "./backend/types";

/** Which backend the terminal serves for this trader (section 6.1): Trial → trial engine; active pool → live. */
export function traderMode(status: TraderStatus, profile: ChainProfile | null): Mode | "none" {
  if (status === "trial") return "trial";
  if (profile && !isDefaultKey(profile.activePool)) return "live";
  return "none";
}
