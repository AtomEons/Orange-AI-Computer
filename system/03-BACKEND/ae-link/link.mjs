import {
  AE_LINK_CHANNELS,
  AE_LINK_CHANNEL_PRIORITY,
  AE_LINK_PROTOCOL,
  AELinkProtocolError,
  FrameDecoder,
  encodeFrame,
} from './protocol.mjs';
import { UnackedJournal } from './journal.mjs';

const TRANSITIONS = Object.freeze({
  disconnected: new Set(['connecting', 'handshaking', 'backoff', 'stopped']),
  connecting: new Set(['handshaking', 'disconnected', 'stopped']),
  handshaking: new Set(['connected', 'disconnected', 'stopped']),
  connected: new Set(['disconnected', 'stopped']),
  backoff: new Set(['connecting', 'disconnected', 'stopped']),
  stopped: new Set(['connecting', 'handshaking']),
});

function emptyCursors() {
  return Object.fromEntries(AE_LINK_CHANNELS.map((channel) => [channel, 0]));
}

function assertChannel(channel) {
  if (!AE_LINK_CHANNELS.includes(channel)) throw new AELinkProtocolError(`unknown AE Link channel: ${channel}`);
}

function assertCursor(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AELinkProtocolError(`${label} must be a non-negative safe integer`);
  }
}

function normalizedCursors(cursors = {}) {
  const result = emptyCursors();
  for (const channel of AE_LINK_CHANNELS) {
    const value = cursors[channel] ?? 0;
    assertCursor(value, `${channel} cursor`);
    result[channel] = value;
  }
  return result;
}

export class ChannelScheduler {
  constructor() {
    this.queues = new Map(AE_LINK_CHANNELS.map((channel) => [channel, []]));
    this.queued = new Set();
  }

  get size() {
    return this.queued.size;
  }

  enqueue(message, { front = false } = {}) {
    assertChannel(message?.channel);
    const key = `${message.channel}:${message.seq}`;
    if (this.queued.has(key)) return false;
    const queue = this.queues.get(message.channel);
    if (front) queue.unshift(message);
    else queue.push(message);
    this.queued.add(key);
    return true;
  }

  dequeue() {
    for (const channel of [...AE_LINK_CHANNELS].sort(
      (left, right) => AE_LINK_CHANNEL_PRIORITY[left] - AE_LINK_CHANNEL_PRIORITY[right],
    )) {
      const message = this.queues.get(channel).shift();
      if (!message) continue;
      this.queued.delete(`${message.channel}:${message.seq}`);
      return message;
    }
    return null;
  }

  rebuild(messages) {
    for (const queue of this.queues.values()) queue.length = 0;
    this.queued.clear();
    for (const message of messages) this.enqueue(message);
  }
}

export class AELink {
  constructor({
    id,
    journalPath,
    integrityKey,
    connector = null,
    autoReconnect = connector != null,
    heartbeatMs = 5_000,
    reconnectBaseMs = 100,
    reconnectMaxMs = 10_000,
    clock = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    getStateRoot = () => null,
    onStateRootMismatch = () => {},
    onMessage = () => {},
    onStateChange = () => {},
    onError = () => {},
  }) {
    if (!id) throw new TypeError('AE Link id is required');
    this.id = String(id);
    this.integrityKey = integrityKey;
    this.connector = connector;
    this.autoReconnect = Boolean(autoReconnect);
    this.heartbeatMs = heartbeatMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.clock = clock;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.getStateRoot = getStateRoot;
    this.onStateRootMismatch = onStateRootMismatch;
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.onError = onError;

    this.journal = new UnackedJournal({ filePath: journalPath, nodeId: this.id, integrityKey });
    this.scheduler = new ChannelScheduler();
    this.scheduler.rebuild(this.journal.pending());
    this.decoder = new FrameDecoder(integrityKey);
    this.received = emptyCursors();
    this.pendingInbound = new Map(AE_LINK_CHANNELS.map((channel) => [channel, new Map()]));
    this.transport = null;
    this.peerId = null;
    this.state = 'disconnected';
    this.stateHistory = [{ state: this.state, reason: 'created', at: this.clock() }];
    this.manualStop = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatSequence = 0;
    this.lastRemoteHeartbeat = 0;
    this.lastMismatch = null;
    this.lastError = null;
    this.stats = { sent: 0, received: 0, duplicates: 0, reconnects: 0 };
  }

  async start() {
    this.manualStop = false;
    if (!this.connector) return this.state;
    await this.#attemptConnect();
    return this.state;
  }

  stop(reason = 'operator-stop') {
    this.manualStop = true;
    this.#clearReconnect();
    this.#stopHeartbeat();
    const transport = this.transport;
    this.transport = null;
    this.#transition('stopped', reason);
    if (transport) this.#terminateTransport(transport);
  }

  attachTransport(transport, reason = 'transport-open') {
    if (!transport || typeof transport.write !== 'function') throw new TypeError('transport must provide write(bytes)');
    this.manualStop = false;
    this.#clearReconnect();
    this.#stopHeartbeat();
    this.transport = transport;
    this.decoder = new FrameDecoder(this.integrityKey);
    this.#transition('handshaking', reason);
    this.#writeControl({
      protocol: AE_LINK_PROTOCOL,
      type: 'hello',
      sender: this.id,
      resume: { received: this.receivedSnapshot() },
      stateRoot: this.#localStateRoot(),
    });
  }

  transportClosed(reason = 'transport-closed', transport) {
    if (transport !== undefined && transport !== this.transport) return;
    this.transport = null;
    this.#stopHeartbeat();
    this.scheduler.rebuild(this.journal.pending());
    if (this.manualStop) return;
    if (this.state !== 'disconnected') this.#transition('disconnected', String(reason));
    this.#scheduleReconnect(reason);
  }

  receiveBytes(bytes, transport = this.transport) {
    if (transport !== this.transport || !this.transport) return false;
    try {
      for (const message of this.decoder.push(bytes)) this.#handleMessage(message);
      return true;
    } catch (error) {
      this.#failConnection(error);
      return false;
    }
  }

  send(channel, payload) {
    assertChannel(channel);
    const seq = this.journal.next(channel);
    const message = {
      protocol: AE_LINK_PROTOCOL,
      type: 'data',
      sender: this.id,
      channel,
      seq,
      payload: structuredClone(payload),
    };
    this.journal.append(message);
    this.scheduler.enqueue(message);
    this.flush();
    return seq;
  }

  flush() {
    if (this.state !== 'connected' || !this.transport) return 0;
    let sent = 0;
    while (this.state === 'connected' && this.transport) {
      const message = this.scheduler.dequeue();
      if (!message) break;
      if (!this.#write(message)) {
        this.scheduler.enqueue(message, { front: true });
        break;
      }
      sent += 1;
      this.stats.sent += 1;
    }
    return sent;
  }

  sendHeartbeat() {
    if (this.state !== 'connected' || !this.transport) return false;
    this.heartbeatSequence += 1;
    return this.#writeControl({
      protocol: AE_LINK_PROTOCOL,
      type: 'heartbeat',
      sender: this.id,
      heartbeat: this.heartbeatSequence,
      received: this.receivedSnapshot(),
      stateRoot: this.#localStateRoot(),
      at: this.clock(),
    });
  }

  receivedSnapshot() {
    return { ...this.received };
  }

  status() {
    return {
      id: this.id,
      peerId: this.peerId,
      state: this.state,
      pending: this.journal.size,
      queued: this.scheduler.size,
      received: this.receivedSnapshot(),
      heartbeatSequence: this.heartbeatSequence,
      lastRemoteHeartbeat: this.lastRemoteHeartbeat,
      stats: { ...this.stats },
    };
  }

  #handleMessage(message) {
    if (!message || message.protocol !== AE_LINK_PROTOCOL || typeof message.sender !== 'string' || !message.sender) {
      throw new AELinkProtocolError('message envelope is invalid');
    }
    if (message.sender === this.id) throw new AELinkProtocolError('refusing looped-back message from self');
    if (this.peerId && message.sender !== this.peerId) {
      throw new AELinkProtocolError(`transport peer changed from ${this.peerId} to ${message.sender}`);
    }
    this.peerId = message.sender;

    switch (message.type) {
      case 'hello':
        this.#handleHello(message);
        break;
      case 'heartbeat':
        this.#handleHeartbeat(message);
        break;
      case 'ack':
        this.#handleAck(message);
        break;
      case 'data':
        this.#handleData(message);
        break;
      default:
        throw new AELinkProtocolError(`unknown message type: ${message.type}`);
    }
  }

  #handleHello(message) {
    const peerReceived = normalizedCursors(message.resume?.received);
    this.journal.acknowledgeMany(peerReceived);
    this.#reconcileStateRoot(message.stateRoot, 'hello');
    this.scheduler.rebuild(this.journal.pending());
    if (this.state === 'handshaking') {
      if (this.reconnectAttempt > 0) this.stats.reconnects += 1;
      this.reconnectAttempt = 0;
      this.#transition('connected', 'resume-negotiated');
    } else if (this.state !== 'connected') {
      throw new AELinkProtocolError(`hello received while ${this.state}`);
    }
    this.#startHeartbeat();
    this.flush();
  }

  #handleHeartbeat(message) {
    if (this.state !== 'connected') throw new AELinkProtocolError(`heartbeat received while ${this.state}`);
    assertCursor(message.heartbeat, 'heartbeat sequence');
    if (message.heartbeat < 1) throw new AELinkProtocolError('heartbeat sequence must be positive');
    this.lastRemoteHeartbeat = Math.max(this.lastRemoteHeartbeat, message.heartbeat);
    this.journal.acknowledgeMany(normalizedCursors(message.received));
    this.#reconcileStateRoot(message.stateRoot, 'heartbeat');
  }

  #handleAck(message) {
    if (this.state !== 'connected') throw new AELinkProtocolError(`ack received while ${this.state}`);
    assertChannel(message.channel);
    assertCursor(message.ack, 'ack sequence');
    this.journal.acknowledge(message.channel, message.ack);
  }

  #handleData(message) {
    if (this.state !== 'connected') throw new AELinkProtocolError(`data received while ${this.state}`);
    assertChannel(message.channel);
    if (!Number.isSafeInteger(message.seq) || message.seq < 1) {
      throw new AELinkProtocolError('data sequence must be a positive safe integer');
    }
    const current = this.received[message.channel];
    if (message.seq <= current) {
      this.stats.duplicates += 1;
      this.#sendAck(message.channel, current);
      return;
    }
    if (message.seq > current + 1) {
      this.pendingInbound.get(message.channel).set(message.seq, message);
      this.#sendAck(message.channel, current);
      return;
    }

    this.#deliver(message);
    const pending = this.pendingInbound.get(message.channel);
    while (pending.has(this.received[message.channel] + 1)) {
      const next = pending.get(this.received[message.channel] + 1);
      pending.delete(next.seq);
      this.#deliver(next);
    }
    this.#sendAck(message.channel, this.received[message.channel]);
  }

  #deliver(message) {
    this.onMessage({
      sender: message.sender,
      channel: message.channel,
      seq: message.seq,
      payload: structuredClone(message.payload),
    });
    this.received[message.channel] = message.seq;
    this.stats.received += 1;
  }

  #sendAck(channel, sequence) {
    this.#writeControl({
      protocol: AE_LINK_PROTOCOL,
      type: 'ack',
      sender: this.id,
      channel,
      ack: sequence,
    });
  }

  #localStateRoot() {
    const root = this.getStateRoot();
    if (root == null) return null;
    if (typeof root !== 'string' || !root) throw new AELinkProtocolError('state root hook must return a string or null');
    return root;
  }

  #reconcileStateRoot(remoteRoot, phase) {
    if (remoteRoot != null && (typeof remoteRoot !== 'string' || !remoteRoot)) {
      throw new AELinkProtocolError('remote state root must be a string or null');
    }
    const localRoot = this.#localStateRoot();
    if (localRoot == null || remoteRoot == null || localRoot === remoteRoot) {
      this.lastMismatch = null;
      return;
    }
    const signature = `${localRoot}\u0000${remoteRoot}`;
    if (signature === this.lastMismatch) return;
    this.lastMismatch = signature;
    const result = this.onStateRootMismatch({
      localRoot,
      remoteRoot,
      peerId: this.peerId,
      phase,
      received: this.receivedSnapshot(),
    });
    if (result && typeof result.then === 'function') result.catch((error) => this.#recordError(error));
  }

  #writeControl(message) {
    return this.#write(message);
  }

  #write(message) {
    if (!this.transport) return false;
    try {
      const frame = encodeFrame(message, this.integrityKey);
      const result = this.transport.write(frame);
      return result !== false && result !== 0;
    } catch (error) {
      this.#failConnection(error);
      return false;
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    if (!Number.isFinite(this.heartbeatMs) || this.heartbeatMs <= 0) return;
    this.heartbeatTimer = this.setIntervalFn(() => this.sendHeartbeat(), this.heartbeatMs);
    this.heartbeatTimer?.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer != null) this.clearIntervalFn(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async #attemptConnect() {
    if (this.manualStop || !this.connector) return;
    this.#transition('connecting', this.reconnectAttempt === 0 ? 'connect' : 'reconnect');
    try {
      const handlers = {
        onOpen: (transport) => this.attachTransport(transport),
        onData: (transport, bytes) => this.receiveBytes(bytes, transport),
        onDrain: (transport) => { if (transport === this.transport) this.flush(); },
        onClose: (transport, reason) => this.transportClosed(reason, transport),
        onError: (transport, error) => {
          if (transport === this.transport) this.#recordError(error);
        },
      };
      const transport = await this.connector(handlers);
      if (!this.transport && transport && !this.manualStop) this.attachTransport(transport);
    } catch (error) {
      this.#recordError(error);
      if (this.state !== 'disconnected') this.#transition('disconnected', 'connect-failed');
      this.#scheduleReconnect(error.message || 'connect-failed');
    }
  }

  #scheduleReconnect(reason) {
    if (!this.autoReconnect || !this.connector || this.manualStop || this.reconnectTimer != null) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.#transition('backoff', `${reason}; retry in ${delay}ms`);
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      void this.#attemptConnect();
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  #clearReconnect() {
    if (this.reconnectTimer != null) this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  #failConnection(error) {
    this.#recordError(error);
    const transport = this.transport;
    if (transport) this.#terminateTransport(transport);
    this.transportClosed(`protocol failure: ${error.message}`, transport);
  }

  #terminateTransport(transport) {
    try {
      if (typeof transport.terminate === 'function') transport.terminate();
      else if (typeof transport.end === 'function') transport.end();
      else if (typeof transport.close === 'function') transport.close();
    } catch (error) {
      this.#recordError(error);
    }
  }

  #recordError(error) {
    this.lastError = error instanceof Error ? error : new Error(String(error));
    this.onError(this.lastError);
  }

  #transition(next, reason) {
    if (next === this.state) return;
    if (!TRANSITIONS[this.state]?.has(next)) {
      throw new AELinkProtocolError(`invalid AE Link state transition ${this.state} -> ${next}`);
    }
    const previous = this.state;
    this.state = next;
    const event = { state: next, previous, reason: String(reason), at: this.clock() };
    this.stateHistory.push(event);
    this.onStateChange(event);
  }
}
