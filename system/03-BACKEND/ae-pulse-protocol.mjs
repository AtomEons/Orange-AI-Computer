import { createHmac, timingSafeEqual } from 'node:crypto';

export const AE_PULSE_FRAME_SCHEMA = 'orange.ae-pulse.frame.v1';
export const AE_PULSE_MAGIC = Buffer.from('AEP5');
export const AE_PULSE_VERSION = 1;
export const AE_PULSE_HEADER_BYTES = 28;
export const AE_PULSE_MAX_PAYLOAD = 64 * 1024;
export const AE_PULSE_TYPES = Object.freeze({ HELLO: 1, PULSE: 2, VARIATION: 3, ACK: 4, CLOSE: 5 });

const FLAG_AUTHENTICATED = 1;
const keyBuffer = (key) => key ? (Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')) : null;

export function encodePulseFrame({ type, seq = 0, ack = 0, at = Date.now(), payload = null }, { key = null } = {}) {
  if (!Object.values(AE_PULSE_TYPES).includes(type)) throw new Error(`invalid AE Pulse frame type ${type}`);
  const payloadBuffer = payload == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), 'utf8');
  if (payloadBuffer.length > AE_PULSE_MAX_PAYLOAD) throw new Error(`AE Pulse payload exceeds ${AE_PULSE_MAX_PAYLOAD} bytes`);
  const authKey = keyBuffer(key);
  const header = Buffer.alloc(AE_PULSE_HEADER_BYTES);
  AE_PULSE_MAGIC.copy(header, 0);
  header.writeUInt8(AE_PULSE_VERSION, 4);
  header.writeUInt8(type, 5);
  header.writeUInt16BE(authKey ? FLAG_AUTHENTICATED : 0, 6);
  header.writeUInt32BE(seq >>> 0, 8);
  header.writeUInt32BE(ack >>> 0, 12);
  header.writeBigUInt64BE(BigInt(Math.max(0, Number(at) || Date.now())), 16);
  header.writeUInt32BE(payloadBuffer.length, 24);
  const signed = Buffer.concat([header, payloadBuffer]);
  return authKey ? Buffer.concat([signed, createHmac('sha256', authKey).update(signed).digest()]) : signed;
}

export function createPulseFrameDecoder({ key = null, requireAuthentication = false, onFrame, onError } = {}) {
  let buffer = Buffer.alloc(0);
  const authKey = keyBuffer(key);
  const fail = (error) => onError ? onError(error) : (() => { throw error; })();
  return (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= AE_PULSE_HEADER_BYTES) {
      if (!buffer.subarray(0, 4).equals(AE_PULSE_MAGIC)) {
        const next = buffer.indexOf(AE_PULSE_MAGIC, 1);
        buffer = next >= 0 ? buffer.subarray(next) : Buffer.alloc(0);
        fail(new Error('AE Pulse carrier lost frame alignment'));
        continue;
      }
      const version = buffer.readUInt8(4);
      if (version !== AE_PULSE_VERSION) {
        fail(new Error(`unsupported AE Pulse version ${version}`));
        buffer = buffer.subarray(4);
        continue;
      }
      const authenticated = Boolean(buffer.readUInt16BE(6) & FLAG_AUTHENTICATED);
      const payloadBytes = buffer.readUInt32BE(24);
      if (requireAuthentication && !authenticated) {
        fail(new Error('unauthenticated AE Pulse frame rejected'));
        buffer = buffer.subarray(AE_PULSE_HEADER_BYTES);
        continue;
      }
      if (payloadBytes > AE_PULSE_MAX_PAYLOAD) {
        fail(new Error(`AE Pulse payload length ${payloadBytes} is invalid`));
        buffer = buffer.subarray(AE_PULSE_HEADER_BYTES);
        continue;
      }
      const frameBytes = AE_PULSE_HEADER_BYTES + payloadBytes + (authenticated ? 32 : 0);
      if (buffer.length < frameBytes) return;
      const signedBytes = AE_PULSE_HEADER_BYTES + payloadBytes;
      const signed = buffer.subarray(0, signedBytes);
      if (authenticated) {
        if (!authKey) {
          fail(new Error('authenticated AE Pulse frame received without local key'));
          buffer = buffer.subarray(frameBytes);
          continue;
        }
        const expected = createHmac('sha256', authKey).update(signed).digest();
        const received = buffer.subarray(signedBytes, frameBytes);
        if (!timingSafeEqual(expected, received)) {
          fail(new Error('AE Pulse frame authentication failed'));
          buffer = buffer.subarray(frameBytes);
          continue;
        }
      }
      const payloadBuffer = buffer.subarray(AE_PULSE_HEADER_BYTES, signedBytes);
      let payload = null;
      if (payloadBytes) {
        try { payload = JSON.parse(payloadBuffer.toString('utf8')); }
        catch (error) { fail(new Error(`AE Pulse payload is not JSON: ${error.message}`)); }
      }
      onFrame?.({
        schema: AE_PULSE_FRAME_SCHEMA,
        version,
        type: buffer.readUInt8(5),
        authenticated,
        seq: buffer.readUInt32BE(8),
        ack: buffer.readUInt32BE(12),
        at: Number(buffer.readBigUInt64BE(16)),
        payload,
      });
      buffer = buffer.subarray(frameBytes);
    }
  };
}
