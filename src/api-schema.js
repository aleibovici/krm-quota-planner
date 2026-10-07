/**
 * JSON shapes returned by the planner API and carried in the browser session.
 * Reference from server and UI modules via `/** @import ... */`.
 *
 * @typedef {{ kind: 'cluster'|'git', ref: string, sha: string, date?: string, subject?: string, context?: string, repo?: string, tenancy?: string, fetched?: { ok: boolean, error?: string } }} SourceInfo
 *
 * @typedef {{ enabled: boolean, ok: boolean, error?: string|null, context: string, contexts: string[], readAt: string, pools: Record<string, { cards: number }>, queues: Record<string, { allocatedGpu: number }> }} ClusterOverlay
 *
 * @typedef {{ source: SourceInfo, cluster: ClusterOverlay, loadedAt: string, epoch: number, plan: Plan }} SessionState
 *
 * @typedef {{ level: 'error'|'warning'|'info', code: string, message: string, queue?: string, pool?: string }} Finding
 *
 * @typedef {ReturnType<typeof import('./core/display.js').buildDisplay>} PlanDisplay
 *
 * @typedef {{
 *   base: object|null,
 *   model: { base: object, planned: object },
 *   display: PlanDisplay,
 *   changes: object[],
 *   additions: object[],
 *   pools: Record<string, object>,
 *   findings: Finding[],
 *   expectations: object,
 *   mirrors: object[],
 *   reminders: string[],
 *   files: { path: string, role: string, content: string }[],
 *   diff: string,
 *   empty: boolean,
 *   canCommit: boolean,
 *   message: string,
 *   branch: string,
 * }} Plan
 */

export {};
