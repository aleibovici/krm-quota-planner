/**
 * Planner profile shape (JSON from --config or inline options).
 *
 * @typedef {{
 *   tenancy: string,
 *   expectations?: { file: string, variables?: string[] },
 *   resourceQuotaMirrors?: { file: string, key: string, queue: string }[],
 *   reminders?: string[],
 *   cpuMemoryNote?: string,
 *   commitPrefix?: string,
 *   repo?: string,
 *   ref?: string,
 *   source?: string,
 *   context?: string,
 *   kubeconfig?: string,
 *   displayName?: string,
 * }} PlannerConfig
 */

/**
 * @param {Partial<PlannerConfig> & Record<string, unknown>} raw
 * @returns {PlannerConfig}
 */
export function normalizeConfig(raw) {
  if (!raw?.tenancy || typeof raw.tenancy !== 'string') {
    throw new Error('config needs tenancy — the path to the KRM objects file');
  }
  /** @type {PlannerConfig} */
  const config = { ...raw, tenancy: raw.tenancy };
  if (raw.expectations?.file) {
    config.expectations = {
      file: String(raw.expectations.file),
      variables: Array.isArray(raw.expectations.variables) ? raw.expectations.variables.map(String) : [],
    };
  }
  if (Array.isArray(raw.resourceQuotaMirrors)) {
    config.resourceQuotaMirrors = raw.resourceQuotaMirrors.map((m) => ({
      file: String(m.file),
      key: String(m.key),
      queue: String(m.queue),
    }));
  }
  if (Array.isArray(raw.reminders)) config.reminders = raw.reminders.map(String);
  if (raw.cpuMemoryNote !== undefined) config.cpuMemoryNote = String(raw.cpuMemoryNote);
  if (raw.commitPrefix !== undefined) config.commitPrefix = String(raw.commitPrefix);
  if (raw.displayName !== undefined) config.displayName = String(raw.displayName);
  return config;
}
