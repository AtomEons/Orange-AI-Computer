import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from 'node:crypto';

export const AE_PHASE_PROTOCOL_SCHEMA = 'orange.ae-phase.protocol.v1';
export const AE_PHASE_FRAME_SCHEMA = 'orange.ae-phase.frame.v1';
export const AE_PHASE_RECEIVE_WINDOW_SCHEMA = 'orange.ae-phase.receive-window.v1';
export const AE_PHASE_MAGIC = 'AEPH';
export const AE_PHASE_VERSION = 1;
export const AE_PHASE_HEADER_BYTES = 48;
export const AE_PHASE_TAG_BYTES = 16;
export const AE_PHASE_MAX_DATAGRAM_BYTES = 65_507;
export const AE_PHASE_MAX_PAYLOAD_BYTES = AE_PHASE_MAX_DATAGRAM_BYTES
  - AE_PHASE_HEADER_BYTES
  - AE_PHASE_TAG_BYTES;
export const AE_PHASE_TYPES = Object.freeze({
  HELLO: 1,
  BEACON: 2,
  DELTA: 3,
  ACK: 4,
  HYDRATE_REQUEST: 5,
  HYDRATE_SNAPSHOT: 6,
  CLOSE: 7,
});

const MAGIC_BYTES = Buffer.from(AE_PHASE_MAGIC, 'ascii');
const TYPE_VALUES = new Set(Object.values(AE_PHASE_TYPES));
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const UINT64_MAX = 0xffffffffffffffffn;
const ZERO_STATE_HASH_PREFIX = Buffer.alloc(8);
const KEY_DERIVATION_INFO = Buffer.from('orange.ae-phase.sender-key.v1', 'utf8');
const AEAD_CIPHER = 'aes-256-gcm';
const SENDER_KEY_CACHE = new Map();

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'AEPhaseProtocolError';
  error.code = code;
  throw error;
}

function bytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  fail('INVALID_BYTES', `${label} must be a Buffer or typed-array view`);
}

function fixedBytes(value, length, label, { allowZero = true } = {}) {
  let result;
  if (typeof value === 'string' && new RegExp(`^[a-fA-F0-9]{${length * 2}}$`).test(value)) {
    result = Buffer.from(value, 'hex');
  } else {
    result = bytes(value, label);
  }
  if (result.length !== length) fail('INVALID_LENGTH', `${label} must be exactly ${length} bytes`);
  if (!allowZero && result.equals(Buffer.alloc(length))) fail('INVALID_SENDER_HASH', `${label} may not be all zero`);
  return Buffer.from(result);
}

function baseKey(value) {
  const key = bytes(value, 'baseKey');
  if (key.length !== 32) fail('INVALID_BASE_KEY', 'baseKey must be exactly 32 bytes');
  return key;
}

function uint16(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
    fail('INVALID_UINT16', `${label} must be an unsigned 16-bit integer`);
  }
  return value;
}

function uint32(value, label, { allowZero = true } = {}) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX || (!allowZero && value === 0)) {
    fail('INVALID_UINT32', `${label} must be ${allowZero ? 'an' : 'a positive'} unsigned 32-bit integer`);
  }
  return value;
}

function uint64(value, label) {
  let normalized;
  if (typeof value === 'bigint') {
    normalized = value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    normalized = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    normalized = BigInt(value);
  } else {
    fail('INVALID_UINT64', `${label} must be an unsigned 64-bit integer`);
  }
  if (normalized < 0n || normalized > UINT64_MAX) {
    fail('INVALID_UINT64', `${label} must be an unsigned 64-bit integer`);
  }
  return normalized;
}

function frameType(value) {
  if (!Number.isInteger(value) || !TYPE_VALUES.has(value)) {
    fail('INVALID_FRAME_TYPE', `unsupported AE Phase frame type ${String(value)}`);
  }
  return value;
}

function validateAcknowledgment(ackBase, ackBits) {
  const base = uint32(ackBase, 'ackBase');
  const bits = uint32(ackBits, 'ackBits');
  if (base <= 32) {
    const validBitCount = Math.max(0, base - 1);
    const validMask = validBitCount === 0 ? 0 : (2 ** validBitCount - 1) >>> 0;
    if ((bits & ~validMask) >>> 0) {
      fail('INVALID_ACK_WINDOW', 'ackBits acknowledges a sequence below 1');
    }
  }
  return { ackBase: base, ackBits: bits };
}

function nonceFor(epoch, seq) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(epoch, 0);
  nonce.writeUInt32BE(seq, 8);
  return nonce;
}

function senderKey(key, senderHash) {
  const cacheId = `${key.toString('base64')}:${senderHash.toString('hex')}`;
  const cached = SENDER_KEY_CACHE.get(cacheId);
  if (cached) return cached;
  const derived = Buffer.from(hkdfSync('sha256', key, senderHash, KEY_DERIVATION_INFO, 32));
  if (SENDER_KEY_CACHE.size >= 64) SENDER_KEY_CACHE.delete(SENDER_KEY_CACHE.keys().next().value);
  SENDER_KEY_CACHE.set(cacheId, derived);
  return derived;
}

function senderHashHex(value) {
  return fixedBytes(value, 8, 'senderHash', { allowZero: false }).toString('hex');
}

function validateReceiveWindow(window) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) {
    fail('INVALID_RECEIVE_WINDOW', 'receiveWindow must be an object');
  }
  if (window.schema !== AE_PHASE_RECEIVE_WINDOW_SCHEMA) {
    fail('INVALID_RECEIVE_WINDOW', `receiveWindow schema must be ${AE_PHASE_RECEIVE_WINDOW_SCHEMA}`);
  }
  if (typeof window.initialized !== 'boolean') {
    fail('INVALID_RECEIVE_WINDOW', 'receiveWindow initialized flag is invalid');
  }
  if (window.senderHash != null && !/^[a-f0-9]{16}$/.test(window.senderHash)) {
    fail('INVALID_RECEIVE_WINDOW', 'receiveWindow senderHash is invalid');
  }
  if (window.epoch != null) uint64(window.epoch, 'receiveWindow.epoch');
  validateAcknowledgment(window.ackBase, window.ackBits);
  if (!window.initialized && (window.ackBase !== 0 || window.ackBits !== 0)) {
    fail('INVALID_RECEIVE_WINDOW', 'an uninitialized receiveWindow may not contain acknowledgments');
  }
  return window;
}

/**
 * Header layout: magic(4), version(1), type(1), flags(2), senderHash(8),
 * epoch(8), seq(4), ackBase(4), ackBits(4), stateHashPrefix(8), payloadLength(4).
 * The complete header is AEAD additional authenticated data.
 */
export function encodePhaseFrame({
  type,
  flags = 0,
  senderHash,
  epoch,
  seq,
  ackBase = 0,
  ackBits = 0,
  stateHashPrefix = ZERO_STATE_HASH_PREFIX,
  payload = Buffer.alloc(0),
} = {}, { baseKey: keyInput } = {}) {
  const normalizedType = frameType(type);
  const normalizedFlags = uint16(flags, 'flags');
  const normalizedSenderHash = fixedBytes(senderHash, 8, 'senderHash', { allowZero: false });
  const normalizedEpoch = uint64(epoch, 'epoch');
  const normalizedSeq = uint32(seq, 'seq', { allowZero: false });
  const acknowledgment = validateAcknowledgment(ackBase, ackBits);
  const normalizedStateHash = fixedBytes(stateHashPrefix, 8, 'stateHashPrefix');
  const payloadBuffer = payload == null ? Buffer.alloc(0) : bytes(payload, 'payload');
  if (payloadBuffer.length > AE_PHASE_MAX_PAYLOAD_BYTES) {
    fail('PAYLOAD_TOO_LARGE', `payload exceeds ${AE_PHASE_MAX_PAYLOAD_BYTES} bytes`);
  }
  const normalizedBaseKey = baseKey(keyInput);

  const header = Buffer.alloc(AE_PHASE_HEADER_BYTES);
  MAGIC_BYTES.copy(header, 0);
  header.writeUInt8(AE_PHASE_VERSION, 4);
  header.writeUInt8(normalizedType, 5);
  header.writeUInt16BE(normalizedFlags, 6);
  normalizedSenderHash.copy(header, 8);
  header.writeBigUInt64BE(normalizedEpoch, 16);
  header.writeUInt32BE(normalizedSeq, 24);
  header.writeUInt32BE(acknowledgment.ackBase, 28);
  header.writeUInt32BE(acknowledgment.ackBits, 32);
  normalizedStateHash.copy(header, 36);
  header.writeUInt32BE(payloadBuffer.length, 44);

  const cipher = createCipheriv(
    AEAD_CIPHER,
    senderKey(normalizedBaseKey, normalizedSenderHash),
    nonceFor(normalizedEpoch, normalizedSeq),
    { authTagLength: AE_PHASE_TAG_BYTES },
  );
  cipher.setAAD(header, { plaintextLength: payloadBuffer.length });
  const ciphertext = Buffer.concat([cipher.update(payloadBuffer), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

export function decodePhaseFrame(datagram, {
  baseKey: keyInput,
  receiveWindow = null,
} = {}) {
  const packet = bytes(datagram, 'datagram');
  if (packet.length < AE_PHASE_HEADER_BYTES + AE_PHASE_TAG_BYTES) {
    fail('INVALID_FRAME_LENGTH', 'AE Phase datagram is shorter than the authenticated frame minimum');
  }
  if (!packet.subarray(0, 4).equals(MAGIC_BYTES)) fail('BAD_MAGIC', 'AE Phase frame magic is invalid');
  const version = packet.readUInt8(4);
  if (version !== AE_PHASE_VERSION) fail('BAD_VERSION', `unsupported AE Phase version ${version}`);
  const type = frameType(packet.readUInt8(5));
  const flags = packet.readUInt16BE(6);
  const senderHash = fixedBytes(packet.subarray(8, 16), 8, 'senderHash', { allowZero: false });
  const epoch = packet.readBigUInt64BE(16);
  const seq = uint32(packet.readUInt32BE(24), 'seq', { allowZero: false });
  const { ackBase, ackBits } = validateAcknowledgment(
    packet.readUInt32BE(28),
    packet.readUInt32BE(32),
  );
  const stateHashPrefix = Buffer.from(packet.subarray(36, 44));
  const payloadLength = packet.readUInt32BE(44);
  if (payloadLength > AE_PHASE_MAX_PAYLOAD_BYTES) {
    fail('INVALID_FRAME_LENGTH', `AE Phase payload length ${payloadLength} exceeds the UDP frame limit`);
  }
  const expectedLength = AE_PHASE_HEADER_BYTES + payloadLength + AE_PHASE_TAG_BYTES;
  if (packet.length !== expectedLength) {
    fail('INVALID_FRAME_LENGTH', `AE Phase datagram length ${packet.length} does not match header length ${expectedLength}`);
  }

  const header = packet.subarray(0, AE_PHASE_HEADER_BYTES);
  const ciphertext = packet.subarray(AE_PHASE_HEADER_BYTES, AE_PHASE_HEADER_BYTES + payloadLength);
  const tag = packet.subarray(expectedLength - AE_PHASE_TAG_BYTES);
  const normalizedBaseKey = baseKey(keyInput);
  const decipher = createDecipheriv(
    AEAD_CIPHER,
    senderKey(normalizedBaseKey, senderHash),
    nonceFor(epoch, seq),
    { authTagLength: AE_PHASE_TAG_BYTES },
  );
  decipher.setAAD(header, { plaintextLength: payloadLength });
  decipher.setAuthTag(tag);
  let payload;
  try {
    payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    fail('BAD_AUTH_TAG', 'AE Phase frame authentication failed', error);
  }

  const frame = {
    schema: AE_PHASE_FRAME_SCHEMA,
    version,
    type,
    flags,
    senderHash,
    epoch,
    seq,
    ackBase,
    ackBits,
    stateHashPrefix,
    payload,
  };
  if (receiveWindow) applyReceiveSequence(receiveWindow, frame);
  return frame;
}

export function createReceiveWindow({ senderHash = null, epoch = null } = {}) {
  return {
    schema: AE_PHASE_RECEIVE_WINDOW_SCHEMA,
    senderHash: senderHash == null ? null : senderHashHex(senderHash),
    epoch: epoch == null ? null : uint64(epoch, 'epoch'),
    initialized: false,
    ackBase: 0,
    ackBits: 0,
  };
}

export function applyReceiveSequence(window, { senderHash, epoch, seq } = {}) {
  validateReceiveWindow(window);
  const incomingSenderHash = senderHashHex(senderHash);
  const incomingEpoch = uint64(epoch, 'epoch');
  const incomingSeq = uint32(seq, 'seq', { allowZero: false });

  if (window.senderHash != null && window.senderHash !== incomingSenderHash) {
    fail('SENDER_MISMATCH', 'receiveWindow belongs to a different sender');
  }
  if (window.epoch != null && incomingEpoch < window.epoch) {
    fail('STALE_EPOCH', 'AE Phase frame epoch is older than the receiveWindow epoch');
  }
  window.senderHash = incomingSenderHash;

  if (window.epoch == null || incomingEpoch > window.epoch || !window.initialized) {
    window.epoch = incomingEpoch;
    window.initialized = true;
    window.ackBase = incomingSeq;
    window.ackBits = 0;
    return window;
  }

  if (incomingSeq > window.ackBase) {
    const delta = incomingSeq - window.ackBase;
    if (delta > 32) {
      window.ackBits = 0;
    } else {
      const shifted = delta === 32 ? 0 : (window.ackBits << delta) >>> 0;
      const previousBase = (2 ** (delta - 1)) >>> 0;
      window.ackBits = (shifted | previousBase) >>> 0;
    }
    window.ackBase = incomingSeq;
    return window;
  }

  const distance = window.ackBase - incomingSeq;
  if (distance === 0) fail('REPLAY_SEQUENCE', `AE Phase sequence ${incomingSeq} was already received`);
  if (distance > 32) fail('REPLAY_SEQUENCE', `AE Phase sequence ${incomingSeq} is outside the receive window`);
  const mask = (2 ** (distance - 1)) >>> 0;
  if ((window.ackBits & mask) !== 0) {
    fail('REPLAY_SEQUENCE', `AE Phase sequence ${incomingSeq} was already received`);
  }
  window.ackBits = (window.ackBits | mask) >>> 0;
  return window;
}

export function isAcknowledged(seq, acknowledgment) {
  const sequence = uint32(seq, 'seq', { allowZero: false });
  if (!acknowledgment || typeof acknowledgment !== 'object') {
    fail('INVALID_ACK_WINDOW', 'acknowledgment must contain ackBase and ackBits');
  }
  if (acknowledgment.initialized === false) return false;
  const { ackBase, ackBits } = validateAcknowledgment(
    acknowledgment.ackBase,
    acknowledgment.ackBits,
  );
  if (ackBase === 0 || sequence > ackBase) return false;
  if (sequence === ackBase) return true;
  const distance = ackBase - sequence;
  return distance <= 32 && ((ackBits >>> (distance - 1)) & 1) === 1;
}
