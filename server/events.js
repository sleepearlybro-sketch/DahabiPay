const clients = new Set();

export function connectEvents(req, res) {
  res.set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': keepalive\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function publishEvent(type, data = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}
