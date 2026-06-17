/**
 * walle multi-machine: read the per-machine identity env vars set by the
 * wall-e launcher and produce the spread-fields the bridge sends with every
 * `session_register`.
 *
 * Set in the launcher (`scripts/wall-e/run.ts` for laptops,
 * `src/providers/{pi,omp}.ts` for daemon containers):
 *
 *   WALLE_MACHINE_ID      — operator-assigned slug, e.g. `arch-personal`
 *   WALLE_MACHINE_LABEL   — human display name, e.g. `Arch (this laptop)`
 *   WALLE_MACHINE_ACCENT  — optional CSS color, e.g. `#f0a868`
 *
 * Single-machine and upstream installs leave the env unset; the helper
 * returns `{}` and the bridge omits the fields entirely (back-compat).
 *
 * Pure function — no side effects, no env mutation. Tested in
 * `__tests__/walle-machine-fields.test.ts`.
 *
 * See change: walle-multi-machine.
 */
export interface WalleMachineFields {
  machineId?: string;
  machineLabel?: string;
  machineAccent?: string;
}

export function buildWalleMachineFields(env: NodeJS.ProcessEnv): WalleMachineFields {
  const id = trim(env.WALLE_MACHINE_ID);
  if (!id) return {};
  const out: WalleMachineFields = { machineId: id };
  const label = trim(env.WALLE_MACHINE_LABEL);
  if (label) out.machineLabel = label;
  const accent = trim(env.WALLE_MACHINE_ACCENT);
  if (accent) out.machineAccent = accent;
  return out;
}

function trim(v: string | undefined): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t;
}
