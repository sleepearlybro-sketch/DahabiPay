/* ==========================================================================
   Fixed-point decimal arithmetic.

   Rates, reserves and amounts are money: binary floats round them wrong and
   the error compounds across a rate multiplication. Everything here is a
   BigInt scaled by 10^18, parsed from and serialised back to decimal strings,
   which is also how the database stores them.
   ========================================================================== */

export const DP = 18n;
export const ONE = 10n ** DP;

/** Parse a decimal string (or number) into scaled BigInt. */
export function dec(v) {
  if (typeof v === 'bigint') return v;
  let s = String(v ?? '0').trim();
  if (s === '' || s === '.') s = '0';
  // strip thousands spaces and normalise the separator
  s = s.replace(/[\s_]/g, '').replace(',', '.');
  if (!/^-?\d*(\.\d*)?$/.test(s)) throw new Error(`not a decimal: ${v}`);

  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  let [i = '0', f = ''] = s.split('.');
  if (i === '') i = '0';
  // pad or truncate the fraction to exactly DP digits
  f = (f + '0'.repeat(Number(DP))).slice(0, Number(DP));
  const out = BigInt(i) * ONE + BigInt(f || '0');
  return neg ? -out : out;
}

/**
 * Serialise to a plain decimal string, trailing zeros trimmed.
 * Accepts a scaled BigInt or anything dec() understands, because callers
 * routinely pass the decimal strings that come straight out of the database.
 *
 * @param dp optional precision to round to, half-up.
 */
export function str(x, dp) {
  let v = dec(x);
  const neg = v < 0n;
  if (neg) v = -v;

  if (dp !== undefined) {
    const keep = Math.max(0, Math.min(Number(DP), Number(dp)));
    const cut = Number(DP) - keep;
    if (cut > 0) {
      const unit = 10n ** BigInt(cut);
      const q = v / unit;
      const rem = v % unit;
      v = (rem * 2n >= unit ? q + 1n : q) * unit;   // round half-up
    }
  }

  const i = (v / ONE).toString();
  const f = (v % ONE).toString().padStart(Number(DP), '0').replace(/0+$/, '');
  return (neg && (i !== '0' || f) ? '-' : '') + i + (f ? '.' + f : '');
}

export const add = (a, b) => dec(a) + dec(b);
export const sub = (a, b) => dec(a) - dec(b);
export const mul = (a, b) => (dec(a) * dec(b)) / ONE;
export const div = (a, b) => {
  const d = dec(b);
  if (d === 0n) throw new Error('division by zero');
  return (dec(a) * ONE) / d;
};
export const cmp = (a, b) => {
  const x = dec(a), y = dec(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
export const lt = (a, b) => cmp(a, b) < 0;
export const gt = (a, b) => cmp(a, b) > 0;
export const lte = (a, b) => cmp(a, b) <= 0;
export const gte = (a, b) => cmp(a, b) >= 0;
export const isZero = (a) => dec(a) === 0n;
export const isPos = (a) => dec(a) > 0n;

/** Apply basis points: bp(100) is 1%. Returns the fraction, not the remainder. */
export const bpOf = (amount, bp) => mul(amount, div(String(bp), '10000'));
/** amount less bp, e.g. take a 1.2% fee off the sending leg. */
export const lessBp = (amount, bp) => sub(amount, bpOf(amount, bp));

/**
 * Cross rate: units of `to` for one unit of `from`.
 * The fee always lands on the sending leg, so the quoted receive amount is final.
 */
export function crossRate(fromPivot, toPivot, feeBp) {
  const net = lessBp(fromPivot, feeBp);
  return div(net, toPivot);
}

/** How many decimal places to display a currency at. */
export function displayDp(code) {
  if (/^(BTC|ETH|TON)$/.test(code)) return 8;
  if (/^(USDT|USDC|USD)$/.test(code)) return 2;
  return 2;
}
