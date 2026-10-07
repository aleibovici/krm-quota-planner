// Kubernetes resource.Quantity -> number.
//
// Live KAI Queue status reports usage as quantities, not floats: a 1/8-card
// workspace shows up as `nvidia.com/gpu: "119995506n"` (0.12 GPU), memory as
// "32Gi". Anything that compares live usage with a planned quota has to parse
// these properly; a parseFloat() would read 119995506 GPUs.

const DECIMAL = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const BINARY = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };

/**
 * @param {string|number|null|undefined} q
 * @returns {number} NaN when the input is not a quantity
 */
export function parseQuantity(q) {
  if (typeof q === 'number') return q;
  if (q === null || q === undefined) return NaN;
  const s = String(q).trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/.exec(s);
  if (!m) return NaN;
  const [, digits, exponent, suffix] = m;
  if (exponent) return Number(digits + exponent);
  if (suffix && suffix in BINARY) return Number(digits) * BINARY[suffix];
  return Number(digits) * DECIMAL[suffix ?? ''];
}
