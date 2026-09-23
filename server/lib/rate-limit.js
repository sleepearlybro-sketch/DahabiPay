const buckets = new Map();

export function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 100);
}

export function rateLimit({ name, limit, windowMs, key = (req) => clientIp(req) }) {
  return (req, res, next) => {
    const now = Date.now();
    const id = `${name}:${key(req)}`;
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(id, bucket);
    res.set('x-ratelimit-limit', String(limit));
    res.set('x-ratelimit-remaining', String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      res.set('retry-after', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    next();
  };
}

export function clearRateLimits() { buckets.clear(); }
