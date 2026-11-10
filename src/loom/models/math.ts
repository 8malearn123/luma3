/**
 * Small, dependency-free numerics for the learned models (phase 6): sparse
 * design rows, a ridge-penalised Newton/IRLS solver for Poisson and logistic
 * GLMs, and closed-form ridge regression. Everything is deterministic: zero
 * (or mean-based) initialisation, fixed iteration order, no randomness.
 */
export type SparseRow = { idx: number[]; val: number[] };

/** Solves A x = b for a symmetric positive-definite A (row-major, n×n) by Cholesky. Adds jitter if needed. */
export function solveSpd(a: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let jitter = 0, attempt = 0; attempt < 6; attempt++, jitter = jitter ? jitter * 10 : 1e-9) {
    const l = new Float64Array(n * n);
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = a[i * n + j]! + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) s -= l[i * n + k]! * l[j * n + k]!;
        if (i === j) {
          if (!(s > 0)) { ok = false; break; }
          l[i * n + i] = Math.sqrt(s);
        } else l[i * n + j] = s / l[j * n + j]!;
      }
    }
    if (!ok) continue;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]!; for (let k = 0; k < i; k++) s -= l[i * n + k]! * y[k]!; y[i] = s / l[i * n + i]!; }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = y[i]!; for (let k = i + 1; k < n; k++) s -= l[k * n + i]! * x[k]!; x[i] = s / l[i * n + i]!; }
    return x;
  }
  throw new Error('matrix is not positive definite');
}

export const dot = (row: SparseRow, coef: ArrayLike<number>) => { let s = 0; for (let k = 0; k < row.idx.length; k++) s += coef[row.idx[k]!]! * row.val[k]!; return s; };
export const sigmoid = (x: number) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));
const clampEta = (x: number) => Math.max(-30, Math.min(30, x));

export type GlmFamily = 'poisson' | 'logistic';
export type GlmFit = { coef: number[]; iterations: number; converged: boolean };

function meanOf(family: GlmFamily, eta: number) { return family === 'poisson' ? Math.exp(clampEta(eta)) : sigmoid(eta); }

function penalisedLogLik(family: GlmFamily, rows: SparseRow[], y: number[], w: number[], coef: Float64Array, l2: number[]) {
  let ll = 0;
  for (let i = 0; i < rows.length; i++) {
    const eta = clampEta(dot(rows[i]!, coef));
    ll += family === 'poisson' ? w[i]! * (y[i]! * eta - Math.exp(eta)) : w[i]! * (y[i]! * eta - Math.log1p(Math.exp(-Math.abs(eta))) - Math.max(eta, 0));
  }
  let pen = 0;
  for (let j = 0; j < coef.length; j++) pen += 0.5 * l2[j]! * coef[j]! * coef[j]!;
  return ll - pen;
}

/**
 * Ridge-penalised GLM by Newton's method with step halving.
 * `l2[j]` is the penalty of coefficient j (0 = unpenalised, e.g. the intercept).
 */
export function fitGlm(rows: SparseRow[], y: number[], w: number[], p: number, opts: { family: GlmFamily; l2: number[]; init?: number[]; maxIter?: number; tol?: number }): GlmFit {
  const coef = new Float64Array(p);
  if (opts.init) opts.init.forEach((v, i) => { coef[i] = v; });
  const maxIter = opts.maxIter ?? 30;
  const tol = opts.tol ?? 1e-8;
  let ll = penalisedLogLik(opts.family, rows, y, w, coef, opts.l2);
  for (let it = 1; it <= maxIter; it++) {
    const g = new Float64Array(p);
    const h = new Float64Array(p * p);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const mu = meanOf(opts.family, dot(r, coef));
      const wt = w[i]! * (opts.family === 'poisson' ? mu : mu * (1 - mu));
      const res = w[i]! * (y[i]! - mu);
      for (let a = 0; a < r.idx.length; a++) {
        const ia = r.idx[a]!, va = r.val[a]!;
        g[ia] = g[ia]! + res * va;
        for (let b = 0; b <= a; b++) {
          const ib = r.idx[b]!;
          const v = wt * va * r.val[b]!;
          h[ia * p + ib] = h[ia * p + ib]! + v;
          if (ia !== ib) h[ib * p + ia] = h[ib * p + ia]! + v;
        }
      }
    }
    for (let j = 0; j < p; j++) { g[j] = g[j]! - opts.l2[j]! * coef[j]!; h[j * p + j] = h[j * p + j]! + opts.l2[j]! + 1e-10; }
    const step = solveSpd(h, g, p);
    let t = 1;
    let next = new Float64Array(p);
    let nextLl = -Infinity;
    for (let half = 0; half < 20; half++, t /= 2) {
      next = coef.map((c, j) => c + t * step[j]!);
      nextLl = penalisedLogLik(opts.family, rows, y, w, next, opts.l2);
      if (nextLl >= ll - 1e-12) break;
    }
    const change = Math.abs(nextLl - ll) / (Math.abs(ll) + 1e-9);
    coef.set(next);
    ll = nextLl;
    if (change < tol) return { coef: [...coef], iterations: it, converged: true };
  }
  return { coef: [...coef], iterations: maxIter, converged: false };
}

/** Weighted ridge regression (closed form). `l2[j]` per coefficient. */
export function fitRidge(rows: SparseRow[], y: number[], w: number[], p: number, l2: number[]): number[] {
  const xtx = new Float64Array(p * p);
  const xty = new Float64Array(p);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    for (let a = 0; a < r.idx.length; a++) {
      const ia = r.idx[a]!, va = r.val[a]!;
      xty[ia] = xty[ia]! + w[i]! * va * y[i]!;
      for (let b = 0; b < r.idx.length; b++) xtx[ia * p + r.idx[b]!] = xtx[ia * p + r.idx[b]!]! + w[i]! * va * r.val[b]!;
    }
  }
  for (let j = 0; j < p; j++) xtx[j * p + j] = xtx[j * p + j]! + l2[j]! + 1e-10;
  return [...solveSpd(xtx, xty, p)];
}

/** Two-sided normal quantile for the 90% interval used everywhere in phase 6. */
export const Z90 = 1.6449;
