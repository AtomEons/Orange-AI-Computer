import fs from 'node:fs';
import path from 'node:path';
import { AE_LINK_CHANNELS, AELinkProtocolError, canonicalJson, hmacHex } from './protocol.mjs';

const JOURNAL_SCHEMA = 'ae-link.unacked-journal.v1';

export class AELinkJournalIntegrityError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AELinkJournalIntegrityError';
  }
}

function initialSequences() {
  return Object.fromEntries(AE_LINK_CHANNELS.map((channel) => [channel, 1]));
}

function assertChannel(channel) {
  if (!AE_LINK_CHANNELS.includes(channel)) throw new AELinkProtocolError(`unknown AE Link channel: ${channel}`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new AELinkJournalIntegrityError(`${label} must be a positive safe integer`);
}

export class UnackedJournal {
  constructor({ filePath, nodeId, integrityKey }) {
    if (!filePath) throw new TypeError('journal filePath is required');
    if (!nodeId) throw new TypeError('journal nodeId is required');
    this.filePath = path.resolve(filePath);
    this.nodeId = String(nodeId);
    this.integrityKey = integrityKey;
    this.nextSequence = initialSequences();
    this.records = [];
    this.writeCounter = 0;

    if (fs.existsSync(this.filePath)) this.#load();
    else this.#persist();
  }

  get size() {
    return this.records.length;
  }

  next(channel) {
    assertChannel(channel);
    return this.nextSequence[channel];
  }

  append(message) {
    if (!message || message.type !== 'data') throw new AELinkProtocolError('journal accepts data messages only');
    assertChannel(message.channel);
    const expected = this.next(message.channel);
    if (message.seq !== expected) {
      throw new AELinkProtocolError(`expected ${message.channel} sequence ${expected}, received ${message.seq}`);
    }
    this.records.push(structuredClone(message));
    this.nextSequence[message.channel] = expected + 1;
    this.#persist();
    return message.seq;
  }

  acknowledge(channel, sequence) {
    assertChannel(channel);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new AELinkProtocolError('ack sequence must be a non-negative safe integer');
    }
    const highestSent = this.nextSequence[channel] - 1;
    if (sequence > highestSent) {
      throw new AELinkProtocolError(`ack ${channel}:${sequence} exceeds highest sent sequence ${highestSent}`);
    }
    const before = this.records.length;
    this.records = this.records.filter((message) => message.channel !== channel || message.seq > sequence);
    if (this.records.length !== before) this.#persist();
    return before - this.records.length;
  }

  acknowledgeMany(received = {}) {
    let removed = 0;
    for (const channel of AE_LINK_CHANNELS) {
      const sequence = received[channel] ?? 0;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new AELinkProtocolError(`resume cursor for ${channel} must be a non-negative safe integer`);
      }
      const highestSent = this.nextSequence[channel] - 1;
      if (sequence > highestSent) {
        throw new AELinkProtocolError(`resume cursor ${channel}:${sequence} exceeds highest sent sequence ${highestSent}`);
      }
      const before = this.records.length;
      this.records = this.records.filter((message) => message.channel !== channel || message.seq > sequence);
      removed += before - this.records.length;
    }
    if (removed > 0) this.#persist();
    return removed;
  }

  pending() {
    return this.records.map((message) => structuredClone(message));
  }

  verify() {
    this.#verifyBody({
      schema: JOURNAL_SCHEMA,
      nodeId: this.nodeId,
      nextSequence: this.nextSequence,
      records: this.records,
    });
    return { ok: true, pending: this.records.length, nextSequence: { ...this.nextSequence } };
  }

  #body() {
    return {
      schema: JOURNAL_SCHEMA,
      nodeId: this.nodeId,
      nextSequence: { ...this.nextSequence },
      records: this.records.map((message) => structuredClone(message)),
    };
  }

  #load() {
    let document;
    try {
      document = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new AELinkJournalIntegrityError('unacked journal is not valid JSON', error);
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new AELinkJournalIntegrityError('unacked journal must be an object');
    }
    const { mac, ...body } = document;
    if (typeof mac !== 'string' || hmacHex(body, this.integrityKey) !== mac) {
      throw new AELinkJournalIntegrityError('unacked journal authentication failed');
    }
    this.#verifyBody(body);
    if (body.nodeId !== this.nodeId) {
      throw new AELinkJournalIntegrityError(`journal belongs to ${body.nodeId}, not ${this.nodeId}`);
    }
    this.nextSequence = { ...body.nextSequence };
    this.records = body.records.map((message) => structuredClone(message));
  }

  #verifyBody(body) {
    if (body.schema !== JOURNAL_SCHEMA) throw new AELinkJournalIntegrityError('unacked journal schema is invalid');
    if (typeof body.nodeId !== 'string' || !body.nodeId) throw new AELinkJournalIntegrityError('journal nodeId is invalid');
    if (!body.nextSequence || typeof body.nextSequence !== 'object') {
      throw new AELinkJournalIntegrityError('journal nextSequence map is invalid');
    }
    if (!Array.isArray(body.records)) throw new AELinkJournalIntegrityError('journal records must be an array');

    const seen = new Set();
    for (const channel of AE_LINK_CHANNELS) assertPositiveInteger(body.nextSequence[channel], `${channel} next sequence`);
    for (const message of body.records) {
      if (!message || message.type !== 'data' || message.protocol !== 'ae-link.v1') {
        throw new AELinkJournalIntegrityError('journal contains a non-data message');
      }
      assertChannel(message.channel);
      assertPositiveInteger(message.seq, `${message.channel} sequence`);
      if (message.seq >= body.nextSequence[message.channel]) {
        throw new AELinkJournalIntegrityError(`journal sequence ${message.channel}:${message.seq} was never allocated`);
      }
      const key = `${message.channel}:${message.seq}`;
      if (seen.has(key)) throw new AELinkJournalIntegrityError(`journal contains duplicate ${key}`);
      seen.add(key);
    }
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const body = this.#body();
    const document = `${canonicalJson({ ...body, mac: hmacHex(body, this.integrityKey) })}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${++this.writeCounter}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(tempPath, 'w', 0o600);
      fs.writeFileSync(descriptor, document, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }
}
