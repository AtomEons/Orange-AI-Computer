import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  inspectImageArtifact,
  inspectVideoArtifact,
  verifyImageArtifact,
  inspectPcmWav,
  verifyMusicArtifact,
  verifyTtsArtifact,
  verifyVideoArtifact,
} from '../captain-planet-artifact-verifier.mjs';

const roots = [];
const ffmpeg = 'C:\\AtomEons\\tools\\ffmpeg\\bin\\ffmpeg.exe';

setDefaultTimeout(60_000);

function writePcmWav(filePath, { sampleRate = 24_000, seconds = 1, amplitude = 4_000 } = {}) {
  const frames = Math.floor(sampleRate * seconds);
  const pcm = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin(index / 15) * amplitude), index * 2);
  }
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  fs.writeFileSync(filePath, out);
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Captain Planet artifact verifier', () => {
  test('proves a non-silent PCM artifact without pretending studio quality', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-media-'));
    roots.push(root);
    const artifact = path.join(root, 'speech.wav');
    const sourceReceipt = path.join(root, 'source.json');
    writePcmWav(artifact);
    const hash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(artifact)).digest('hex');
    fs.writeFileSync(sourceReceipt, JSON.stringify({
      schema: 'orange.captain_planet.tts_artifact.v1',
      status: 'TTS_ARTIFACT_GREEN', artifact_proven: true, artifact_sha256: hash,
      artifact_bytes: fs.statSync(artifact).size,
      sample_rate: 24_000, model_id: 'fixture', model_revision: 'fixture', device: 'fixture', generation_seconds: 1,
    }));
    const result = verifyTtsArtifact({ artifactPath: artifact, sourceReceiptPath: sourceReceipt });
    expect(result.runtime_execution_proven).toBe(true);
    expect(result.artifact_technical_quality_proven).toBe(true);
    expect(result.perceptual_quality_proven).toBe(false);
    expect(result.studio_quality_proven).toBe(false);
    expect(result.audio.non_silent).toBe(true);
  });

  test('rejects silent audio', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-media-'));
    roots.push(root);
    const artifact = path.join(root, 'silent.wav');
    writePcmWav(artifact, { amplitude: 0 });
    expect(inspectPcmWav(artifact).non_silent).toBe(false);
  });

  test('proves music runtime separately from listening quality', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-music-'));
    roots.push(root);
    const artifact = path.join(root, 'music.wav');
    const sourceReceipt = path.join(root, 'source.json');
    writePcmWav(artifact, { sampleRate: 48_000, seconds: 10.5, amplitude: 12_000 });
    const hash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(artifact)).digest('hex');
    fs.writeFileSync(sourceReceipt, JSON.stringify({
      schema: 'orange.captain_planet.music_artifact.v1',
      status: 'MUSIC_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED',
      artifact_proven: true,
      artifact_sha256: hash,
      artifact_bytes: fs.statSync(artifact).size,
      sample_rate: 48_000,
      model_id: 'fixture',
      model_revision: 'fixture',
      device: 'fixture',
      generation_seconds: 1,
    }));
    const result = verifyMusicArtifact({ artifactPath: artifact, sourceReceiptPath: sourceReceipt });
    expect(result.runtime_execution_proven).toBe(true);
    expect(result.artifact_technical_quality_proven).toBe(true);
    expect(result.studio_quality_proven).toBe(false);
    expect(result.status).toBe('CAPTAIN_PLANET_MUSIC_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED');
  });

  test('independently decodes and proves a nonblank image artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-image-'));
    roots.push(root);
    const artifact = path.join(root, 'image.png');
    const sourceReceipt = path.join(root, 'source.json');
    execFileSync(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=512x512:rate=1',
      '-frames:v', '1', '-y', artifact,
    ], { windowsHide: true });
    const inspected = inspectImageArtifact(artifact);
    const hash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(artifact)).digest('hex');
    fs.writeFileSync(sourceReceipt, JSON.stringify({
      schema: 'orange.captain_planet.image_artifact.v1',
      status: 'IMAGE_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED',
      artifact_proven: true,
      artifact_sha256: hash,
      artifact_bytes: fs.statSync(artifact).size,
      pixels: { width: 512, height: 512 },
      model: 'fixture',
      model_revisions: { fixture: 'fixture' },
      device: 'fixture',
      generation_seconds: 1,
    }));
    const result = verifyImageArtifact({ artifactPath: artifact, sourceReceiptPath: sourceReceipt });
    expect(inspected.nonblank).toBe(true);
    expect(result.runtime_execution_proven).toBe(true);
    expect(result.artifact_technical_quality_proven).toBe(true);
    expect(result.studio_quality_proven).toBe(false);
  }, 60_000);

  test('independently decodes and proves real frame motion in a video artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-video-'));
    roots.push(root);
    const artifact = path.join(root, 'video.mp4');
    const sourceReceipt = path.join(root, 'source.json');
    execFileSync(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=512x288:rate=24',
      '-t', '1.5', '-pix_fmt', 'yuv420p', '-y', artifact,
    ], { windowsHide: true });
    const inspected = inspectVideoArtifact(artifact);
    const hash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(artifact)).digest('hex');
    fs.writeFileSync(sourceReceipt, JSON.stringify({
      schema: 'orange.captain_planet.video_artifact.v1',
      status: 'VIDEO_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED',
      artifact_proven: true,
      motion_proven: true,
      artifact_sha256: hash,
      artifact_bytes: fs.statSync(artifact).size,
      model: 'fixture',
      model_revision: 'fixture',
      device: 'fixture',
      generation_seconds: 1,
    }));
    const result = verifyVideoArtifact({ artifactPath: artifact, sourceReceiptPath: sourceReceipt });
    expect(inspected.motion_proven).toBe(true);
    expect(result.runtime_execution_proven).toBe(true);
    expect(result.artifact_technical_quality_proven).toBe(true);
    expect(result.studio_quality_proven).toBe(false);
  }, 60_000);

  test('rejects a frozen video even when its source receipt claims motion', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-frozen-video-'));
    roots.push(root);
    const artifact = path.join(root, 'frozen.mp4');
    const sourceReceipt = path.join(root, 'source.json');
    execFileSync(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:size=512x288:rate=24',
      '-t', '1.5', '-pix_fmt', 'yuv420p', '-y', artifact,
    ], { windowsHide: true });
    const hash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(artifact)).digest('hex');
    fs.writeFileSync(sourceReceipt, JSON.stringify({
      schema: 'orange.captain_planet.video_artifact.v1',
      status: 'VIDEO_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED',
      artifact_proven: true,
      motion_proven: true,
      artifact_sha256: hash,
      artifact_bytes: fs.statSync(artifact).size,
      model: 'fixture',
      model_revision: 'fixture',
      device: 'fixture',
      generation_seconds: 1,
    }));
    const result = verifyVideoArtifact({ artifactPath: artifact, sourceReceiptPath: sourceReceipt });
    expect(result.runtime_execution_proven).toBe(true);
    expect(result.video.motion_proven).toBe(false);
    expect(result.artifact_technical_quality_proven).toBe(false);
    expect(result.status).toBe('CAPTAIN_PLANET_VIDEO_ARTIFACT_NEEDS_WORK');
  }, 60_000);
});
