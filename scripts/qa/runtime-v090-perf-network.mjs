import net from 'node:net';

export async function shapeRuntimeNetwork(upstreamPort, rttMs = 0) {
  const sockets = new Set();
  const rate = 20_000_000 / 8;
  // The FIFO retains bytes during the propagation delay as well as rate
  // shaping. Leave room for the bandwidth-delay product in each direction.
  const queueHighWater = 262144 + Math.ceil(rate * rttMs / 2000);
  const stats = { rttMs, megabitsPerSecond: rttMs ? 20 : null, uploadBytes: 0, downloadBytes: 0, queuedPeakBytes: 0 };
  const server = net.createServer({ allowHalfOpen: true }, (downstream) => {
    const upstream = net.connect({ port: upstreamPort, host: '127.0.0.1', allowHalfOpen: true });
    sockets.add(upstream); sockets.add(downstream);
    for (const socket of [upstream, downstream]) {
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => { upstream.destroy(); downstream.destroy(); });
    }
    function pipe(source, destination, direction) {
      let available = performance.now();
      let queued = 0;
      let ended = false;
      let blocked = false;
      let timer;
      const chunks = [];
      function schedule() {
        if (timer !== undefined || blocked || destination.destroyed) return;
        const next = chunks[0];
        if (!next) {
          if (ended) destination.end();
          return;
        }
        timer = setTimeout(flush, Math.max(0, next.due - performance.now()));
      }
      function flush() {
        timer = undefined;
        if (destination.destroyed) return;
        // One queue preserves TCP byte order even when timer deadlines round
        // into different Node timer buckets under CPU load.
        while (chunks.length && chunks[0].due <= performance.now()) {
          const { bytes } = chunks.shift();
          queued -= bytes.length;
          if (!destination.write(bytes)) {
            blocked = true;
            source.pause();
            destination.once('drain', () => {
              blocked = false;
              if (queued < queueHighWater) source.resume();
              schedule();
            });
            break;
          }
        }
        if (!blocked && queued < queueHighWater) source.resume();
        schedule();
      }
      source.on('data', bytes => {
        stats[direction] += bytes.length;
        queued += bytes.length;
        stats.queuedPeakBytes = Math.max(stats.queuedPeakBytes, queued);
        if (queued >= queueHighWater) source.pause();
        available = Math.max(available, performance.now() + rttMs / 2) + (rttMs ? bytes.length / rate * 1000 : 0);
        chunks.push({ bytes, due: available });
        schedule();
      });
      source.on('end', () => { ended = true; schedule(); });
      source.on('close', () => {
        if (!ended) destination.destroy();
      });
      destination.once('close', () => {
        clearTimeout(timer);
        chunks.length = 0;
        if (!ended && !source.destroyed) source.destroy();
      });
    }
    pipe(downstream, upstream, 'uploadBytes');
    pipe(upstream, downstream, 'downloadBytes');
  });
  // A failed ephemeral bind must reach the product runner's cleanup handler.
  // Retry a bounded address collision before recording a failed attempt.
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', listening); reject(error); };
        const listening = () => { server.off('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(0, '127.0.0.1');
      });
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || attempt === 3) throw error;
    }
  }
  return { port: server.address().port, stats, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    return { ...stats, remainingSockets: sockets.size };
  } };
}
