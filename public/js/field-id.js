/** Mirrors parseFieldId in src/core/tenancy.js for the browser (no bundler). */
export function parseFieldId(id) {
  const [kind, owner, queue, ...rest] = id.split('/');
  return { kind, owner, queue, rest };
}
