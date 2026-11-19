import net from 'node:net';

export async function shapeRuntimeNetwork(upstreamPort, rttMs = 0) {
  const sockets = new Set();
  const rate = 20_000_000 / 8;
  const stats = { rttMs, megabitsPerSecond: rttMs ? 20 : null, uploadBytes: 0, downloadBytes: 0, queuedPeakBytes: 0 };
  const server = net.createServer((downstream) => {
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    sockets.add(upstream); sockets.add(downstream);
    for (const socket of [upstream, downstream]) {
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => { upstream.destroy(); downstream.destroy(); });
    }
    function pipe(source, destination, direction) {
      let available = performance.now(), queued = 0;
      const timers = new Set();
      source.on('data', (bytes) => {
        stats[direction] += bytes.length;
        queued += bytes.length;
        stats.queuedPeakBytes = Math.max(stats.queuedPeakBytes, queued);
        if (queued >= 262144) source.pause();
        available = Math.max(available, performance.now() + rttMs / 2) + (rttMs ? bytes.length / rate * 1000 : 0);
        const timer = setTimeout(() => {
          timers.delete(timer);
          queued -= bytes.length;
          if (!destination.destroyed && !destination.write(bytes)) destination.once('drain', () => { if (queued < 262144) source.resume(); });
          else if (queued < 262144) source.resume();
        }, Math.max(0, available - performance.now()));
        timers.add(timer);
      });
      source.on('end', () => setTimeout(() => destination.end(), Math.max(0, available - performance.now())));
      source.on('close', () => { for (const timer of timers) clearTimeout(timer); destination.destroy(); });
    }
    pipe(downstream, upstream, 'uploadBytes');
    pipe(upstream, downstream, 'downloadBytes');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, stats, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    return { ...stats, remainingSockets: sockets.size };
  } };
}
