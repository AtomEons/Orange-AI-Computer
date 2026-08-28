export function createBunTcpConnector({ hostname = '127.0.0.1', port }) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('TCP port is invalid');
  return (handlers) => Bun.connect({
    hostname,
    port,
    socket: {
      open(socket) {
        handlers.onOpen(socket);
      },
      data(socket, bytes) {
        handlers.onData(socket, bytes);
      },
      drain(socket) {
        handlers.onDrain(socket);
      },
      close(socket) {
        handlers.onClose(socket, 'tcp-close');
      },
      error(socket, error) {
        handlers.onError(socket, error);
      },
      connectError(socket, error) {
        handlers.onError(socket, error);
      },
    },
  });
}

export function createBunTcpServer({ hostname = '127.0.0.1', port = 0, createLink }) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError('TCP port is invalid');
  if (typeof createLink !== 'function') throw new TypeError('createLink is required');
  const links = new Set();
  const server = Bun.listen({
    hostname,
    port,
    socket: {
      open(socket) {
        const link = createLink({ remoteAddress: socket.remoteAddress });
        socket.data = { link };
        links.add(link);
        link.attachTransport(socket, 'inbound-transport-open');
      },
      data(socket, bytes) {
        socket.data.link.receiveBytes(bytes, socket);
      },
      drain(socket) {
        socket.data.link.flush();
      },
      close(socket) {
        const link = socket.data?.link;
        if (!link) return;
        link.transportClosed('tcp-close', socket);
        links.delete(link);
      },
      error(socket, error) {
        socket.data?.link?.transportClosed(`tcp-error: ${error.message}`, socket);
      },
    },
  });

  return {
    server,
    hostname,
    get port() {
      return server.port;
    },
    get activeLinks() {
      return [...links];
    },
    stop(closeActiveConnections = true) {
      for (const link of links) link.stop('server-stop');
      links.clear();
      server.stop(closeActiveConnections);
    },
  };
}
