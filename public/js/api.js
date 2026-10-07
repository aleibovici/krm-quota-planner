import { TOKEN } from './constants.js';
import { session } from './state.js';

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-planner-token': TOKEN, ...(session ? { 'x-planner-epoch': String(session.epoch) } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
