import { createHmac, timingSafeEqual } from 'node:crypto';

export const AE_LINK_PROTOCOL = 'ae-link.v1';
export const AE_LINK_CHANNELS = Object.freeze(['control', 'memory', 'model', 'telemetry', 'artifact']);
export const AE_LINK_CHANNEL_PRIORITY = Object.freeze(Object.fromEntries(
  AE_LINK_CHANNELS.map((channel, priority) => [channel, priority]),
));
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class AELinkProtocolError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AELinkProtocolError';
  }
}

function jsonValue(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new AELinkProtocolError('value is not JSON serializable');
  try {
    return JSON.parse(encoded);
  } catch (error) {
    throw new AELinkProtocolError('value is not JSON serializable', error);
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function canonicalJson(value) {
  return stableJson(jsonValue(value));
}

export function hmacHex(value, integrityKey) {
  if (integrityKey == null || Buffer.byteLength(String(integrityKey)) === 0) {
    throw new AELinkProtocolError('integrityKey is required');
  }
  return createHmac('sha256', integrityKey).update(canonicalJson(value)).digest('hex');
}

export function signMessage(message, integrityKey) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new AELinkProtocolError('message must be an object');
  }
  if (Object.hasOwn(message, 'mac')) throw new AELinkProtocolError('message must not contain a mac');
  return { ...jsonValue(message), mac: hmacHex(message, integrityKey) };
}

export function verifySignedMessage(signedMessage, integrityKey) {
  if (!signedMessage || typeof signedMessage !== 'object' || Array.isArray(signedMessage)) {
    throw new AELinkProtocolError('signed message must be an object');
  }
  const { mac, ...message } = signedMessage;
  if (typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) {
    throw new AELinkProtocolError('frame authentication code is missing or malformed');
  }
  const expected = hmacHex(message, integrityKey);
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(mac, 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new AELinkProtocolError('frame authentication failed');
  }
  return message;
}

export function encodeFrame(message, integrityKey, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  const body = Buffer.from(JSON.stringify(signMessage(message, integrityKey)), 'utf8');
  if (body.byteLength === 0 || body.byteLength > maxFrameBytes) {
    throw new AELinkProtocolError(`frame length ${body.byteLength} is outside the allowed range`);
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  constructor(integrityKey, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.integrityKey = integrityKey;
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new AELinkProtocolError('frame chunk must be bytes');
    this.buffer = this.buffer.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const messages = [];
    let offset = 0;
    while (this.buffer.byteLength - offset >= 4) {
      const length = this.buffer.readUInt32BE(offset);
      if (length === 0 || length > this.maxFrameBytes) {
        this.buffer = Buffer.alloc(0);
        throw new AELinkProtocolError(`frame length ${length} is outside the allowed range`);
      }
      if (this.buffer.byteLength - offset - 4 < length) break;
      const body = this.buffer.subarray(offset + 4, offset + 4 + length);
      let signedMessage;
      try {
        signedMessage = JSON.parse(textDecoder.decode(body));
      } catch (error) {
        this.buffer = Buffer.alloc(0);
        throw new AELinkProtocolError('frame body is not valid UTF-8 JSON', error);
      }
      messages.push(verifySignedMessage(signedMessage, this.integrityKey));
      offset += 4 + length;
    }
    if (offset > 0) this.buffer = Buffer.from(this.buffer.subarray(offset));
    return messages;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}
