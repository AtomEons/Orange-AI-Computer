#!/usr/bin/env bun

const port = Number(process.argv[2] || 8915);
const socket = await Bun.udpSocket({
  port,
  hostname: '0.0.0.0',
  socket: {
    data(server, packet, remotePort, remoteAddress) {
      server.send(packet, remotePort, remoteAddress);
    },
  },
});

process.stdout.write(`${JSON.stringify({ ok: true, mode: 'echo', port: socket.port })}\n`);
const stop = () => { socket.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
