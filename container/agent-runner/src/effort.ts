/**
 * Reasoning effort for query(), read from DAYSTROM_AGENT_EFFORT (set by the
 * host only for models whose MODEL_MAP entry names one). Anything outside the
 * SDK's levels is dropped so the SDK default applies, with one warning.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function resolveEffort(
  raw: string | undefined,
  warn: (message: string) => void,
): EffortLevel | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (LEVELS.includes(raw)) return raw as EffortLevel;
  warn(
    `Ignoring DAYSTROM_AGENT_EFFORT=${JSON.stringify(raw)}; using SDK default`,
  );
  return undefined;
}
