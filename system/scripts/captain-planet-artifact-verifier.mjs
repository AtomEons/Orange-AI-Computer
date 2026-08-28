#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const MEDIA_TOOL_ROOT = 'C:\\AtomEons\\tools\\ffmpeg\\bin';

function mediaTool(name) {
  const override = process.env[`ORANGE5_${name.toUpperCase()}`];
  if (override && fs.existsSync(override)) return override;
  const bundled = path.join(MEDIA_TOOL_ROOT, `${name}.exe`);
  return fs.existsSync(bundled) ? bundled : name;
}

function ffprobe(filePath) {
  return JSON.parse(execFileSync(mediaTool('ffprobe'), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { encoding: 'utf8', windowsHide: true }));
}

function decodeRgbFrames(filePath, {
  width = 64,
  height = 64,
  maxFrames = 12,
  sampleFps = null,
} = {}) {
  const filters = [];
  if (Number.isFinite(sampleFps) && sampleFps > 0) filters.push(`fps=${sampleFps}`);
  filters.push(`scale=${width}:${height}:flags=area`);
  const bytes = execFileSync(mediaTool('ffmpeg'), [
    '-v', 'error', '-i', filePath, '-vf', filters.join(','),
    '-frames:v', String(maxFrames), '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const frameBytes = width * height * 3;
  const frames = [];
  for (let offset = 0; offset + frameBytes <= bytes.length; offset += frameBytes) {
    frames.push(bytes.subarray(offset, offset + frameBytes));
  }
  return frames;
}

function channelStatistics(frame) {
  const count = frame.length / 3;
  const sums = [0, 0, 0];
  const squareSums = [0, 0, 0];
  const luminance = new Array(count);
  const luminanceLevels = new Set();
  let blackPixels = 0;
  let whitePixels = 0;
  for (let index = 0; index < frame.length; index += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = frame[index + channel];
      sums[channel] += value;
      squareSums[channel] += value * value;
    }
    const pixel = index / 3;
    const luma = Math.round(0.2126 * frame[index] + 0.7152 * frame[index + 1] + 0.0722 * frame[index + 2]);
    luminance[pixel] = luma;
    luminanceLevels.add(luma);
    if (frame[index] <= 4 && frame[index + 1] <= 4 && frame[index + 2] <= 4) blackPixels += 1;
    if (frame[index] >= 251 && frame[index + 1] >= 251 && frame[index + 2] >= 251) whitePixels += 1;
  }
  const meanRgb = sums.map((sum) => sum / count);
  const stddevRgb = squareSums.map((sum, channel) => Math.sqrt(Math.max(0, sum / count - meanRgb[channel] ** 2)));
  luminance.sort((left, right) => left - right);
  const percentile = (fraction) => luminance[Math.min(luminance.length - 1, Math.floor(fraction * luminance.length))] ?? 0;
  const meanLuminance = luminance.reduce((sum, value) => sum + value, 0) / Math.max(1, luminance.length);
  const luminanceVariance = luminance.reduce((sum, value) => sum + (value - meanLuminance) ** 2, 0) / Math.max(1, luminance.length);
  return {
    mean_rgb: meanRgb.map((value) => Number(value.toFixed(3))),
    stddev_rgb: stddevRgb.map((value) => Number(value.toFixed(3))),
    mean_luminance: Number(meanLuminance.toFixed(3)),
    luminance_stddev: Number(Math.sqrt(luminanceVariance).toFixed(3)),
    luminance_p05: percentile(0.05),
    luminance_p95: percentile(0.95),
    unique_luminance_levels: luminanceLevels.size,
    black_pixel_fraction: Number((blackPixels / Math.max(1, count)).toFixed(6)),
    white_pixel_fraction: Number((whitePixels / Math.max(1, count)).toFixed(6)),
  };
}

export function inspectImageArtifact(filePath) {
  const probe = ffprobe(filePath);
  const stream = probe.streams?.find((item) => item.codec_type === 'video');
  const frames = decodeRgbFrames(filePath, { maxFrames: 1 });
  if (!stream || frames.length !== 1) throw new Error('image could not be independently decoded');
  const pixels = channelStatistics(frames[0]);
  return {
    codec: stream.codec_name,
    width: Number(stream.width),
    height: Number(stream.height),
    pixel_format: stream.pix_fmt,
    ...pixels,
    nonblank: Math.max(...pixels.stddev_rgb) > 10,
  };
}

export function inspectVideoArtifact(filePath) {
  const probe = ffprobe(filePath);
  const stream = probe.streams?.find((item) => item.codec_type === 'video');
  const parseRate = (value) => {
    const [numerator, denominator = '1'] = String(value || '0/1').split('/').map(Number);
    return denominator ? numerator / denominator : 0;
  };
  const fps = parseRate(stream.avg_frame_rate || stream.r_frame_rate);
  const duration = Number(stream.duration || probe.format?.duration || 0);
  const frameCount = Number(stream.nb_frames || Math.round(duration * fps));
  const sampleFps = duration > 0 ? Math.min(fps || 12, 12 / duration) : null;
  const frames = decodeRgbFrames(filePath, { sampleFps });
  if (!stream || frames.length < 2) throw new Error('video could not be independently decoded');
  const deltas = [];
  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    let total = 0;
    for (let index = 0; index < frames[frameIndex].length; index += 1) {
      total += Math.abs(frames[frameIndex][index] - frames[frameIndex - 1][index]);
    }
    deltas.push(total / frames[frameIndex].length);
  }
  const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const frameStatistics = frames.map(channelStatistics);
  return {
    codec: stream.codec_name,
    width: Number(stream.width),
    height: Number(stream.height),
    pixel_format: stream.pix_fmt,
    fps: Number(fps.toFixed(3)),
    duration_seconds: Number(duration.toFixed(3)),
    frame_count: frameCount,
    decoded_sample_frames: frames.length,
    sampling_fps: sampleFps ? Number(sampleFps.toFixed(3)) : null,
    sampled_consecutive_mean_abs_delta: Number(meanDelta.toFixed(4)),
    sampled_consecutive_max_abs_delta: Number(Math.max(...deltas).toFixed(4)),
    moving_sample_fraction: Number((deltas.filter((value) => value > 0.35).length / deltas.length).toFixed(4)),
    black_frame_fraction: Number((frameStatistics.filter((item) => item.mean_luminance < 8).length / frames.length).toFixed(4)),
    minimum_frame_luminance_stddev: Number(Math.min(...frameStatistics.map((item) => item.luminance_stddev)).toFixed(3)),
    motion_proven: meanDelta > 0.35 && Math.max(...deltas) > 0.75,
  };
}

export function inspectPcmWav(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('artifact is not a RIFF/WAVE file');
  }
  let offset = 12;
  let format = null;
  let audio = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(data.length, start + size);
    if (id === 'fmt ' && size >= 16) {
      format = {
        audio_format: data.readUInt16LE(start),
        channels: data.readUInt16LE(start + 2),
        sample_rate: data.readUInt32LE(start + 4),
        byte_rate: data.readUInt32LE(start + 8),
        block_align: data.readUInt16LE(start + 12),
        bits_per_sample: data.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') audio = data.subarray(start, end);
    offset = start + size + (size % 2);
  }
  if (!format || !audio) throw new Error('WAV is missing fmt or data chunk');
  if (format.audio_format !== 1 || format.bits_per_sample !== 16) {
    throw new Error(`only PCM16 WAV is supported, got format=${format.audio_format} bits=${format.bits_per_sample}`);
  }
  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let activeSamples = 0;
  let clippedSamples = 0;
  const samples = Math.floor(audio.length / 2);
  for (let index = 0; index < samples; index += 1) {
    const value = audio.readInt16LE(index * 2) / 32768;
    sum += value;
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) > 0.005) activeSamples += 1;
    if (Math.abs(value) >= 32760 / 32768) clippedSamples += 1;
  }
  const frames = samples / Math.max(1, format.channels);
  const rms = samples ? Math.sqrt(sumSquares / samples) : 0;
  return {
    ...format,
    bytes: data.length,
    frames,
    duration_seconds: Number((frames / format.sample_rate).toFixed(3)),
    rms: Number(rms.toFixed(6)),
    peak: Number(peak.toFixed(6)),
    rms_dbfs: rms > 0 ? Number((20 * Math.log10(rms)).toFixed(3)) : null,
    peak_dbfs: peak > 0 ? Number((20 * Math.log10(peak)).toFixed(3)) : null,
    dc_offset: Number((sum / Math.max(1, samples)).toFixed(6)),
    active_sample_fraction: Number((activeSamples / Math.max(1, samples)).toFixed(6)),
    clipped_sample_fraction: Number((clippedSamples / Math.max(1, samples)).toFixed(8)),
    non_silent: rms > 0.005 && peak > 0.02,
  };
}

function proofEnvelope({ status, needsWorkStatus, organ, source, artifactPath, sourceReceiptPath, artifactSha256, checks, measurements, unresolved }) {
  const runtimeExecutionProven = Object.values(checks.runtime).every(Boolean);
  const artifactTechnicalQualityProven = runtimeExecutionProven && Object.values(checks.technical_quality).every(Boolean);
  return {
    schema: 'orange5.captain-planet.artifact-quality-proof.v2',
    status: artifactTechnicalQualityProven ? status : needsWorkStatus,
    generated_at: new Date().toISOString(),
    organ,
    runtime_execution_proven: runtimeExecutionProven,
    artifact_technical_quality_proven: artifactTechnicalQualityProven,
    perceptual_quality_proven: false,
    studio_quality_proven: false,
    quality_scope: 'DETERMINISTIC_TECHNICAL_ARTIFACT_QUALITY_ONLY',
    unresolved_quality_gates: unresolved,
    artifact: path.resolve(artifactPath),
    artifact_sha256: artifactSha256,
    source_receipt: path.resolve(sourceReceiptPath),
    checks: { ...checks.runtime, ...checks.technical_quality },
    check_groups: checks,
    ...measurements,
    source_created_at: source.created_at ?? null,
  };
}

export function verifyTtsArtifact({ artifactPath, sourceReceiptPath }) {
  const source = JSON.parse(fs.readFileSync(sourceReceiptPath, 'utf8'));
  const artifactSha256 = sha256File(artifactPath);
  const audio = inspectPcmWav(artifactPath);
  const checks = {
    runtime: {
    source_receipt_contract: source.schema === 'orange.captain_planet.tts_artifact.v1',
    source_runtime_status: ['TTS_ARTIFACT_GREEN', 'TTS_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED'].includes(source.status) && source.artifact_proven === true,
    source_hash_matches: String(source.artifact_sha256 || '').toLowerCase() === artifactSha256,
    source_size_matches: Number(source.artifact_bytes) === fs.statSync(artifactPath).size,
    sample_rate_matches: Number(source.sample_rate) === audio.sample_rate,
    },
    technical_quality: {
    duration_is_substantive: audio.duration_seconds >= 1,
    signal_is_non_silent: audio.non_silent,
    peak_is_not_clipped: audio.peak < 0.999,
    clipped_sample_fraction_is_bounded: audio.clipped_sample_fraction <= 0.001,
    dc_offset_is_bounded: Math.abs(audio.dc_offset) < 0.1,
    active_signal_is_substantive: audio.active_sample_fraction >= 0.05,
    },
  };
  return {
    ...proofEnvelope({
      status: 'CAPTAIN_PLANET_TTS_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
      needsWorkStatus: 'CAPTAIN_PLANET_TTS_ARTIFACT_NEEDS_WORK',
      organ: 'qwen3_tts', source, artifactPath, sourceReceiptPath, artifactSha256, checks,
      measurements: { audio },
      unresolved: ['speech_intelligibility', 'pronunciation_accuracy', 'speaker_fit', 'human_listening_review', 'studio_readiness'],
    }),
    source_model_id: source.model_id,
    source_model_revision: source.model_revision,
    source_device: source.device,
    source_generation_seconds: source.generation_seconds,
  };
}

export function verifyMusicArtifact({ artifactPath, sourceReceiptPath }) {
  const source = JSON.parse(fs.readFileSync(sourceReceiptPath, 'utf8'));
  const artifactSha256 = sha256File(artifactPath);
  const audio = inspectPcmWav(artifactPath);
  const checks = {
    runtime: {
    source_receipt_contract: source.schema === 'orange.captain_planet.music_artifact.v1',
    source_runtime_status:
      source.status === 'MUSIC_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED'
      && source.artifact_proven === true,
    source_hash_matches: String(source.artifact_sha256 || '').toLowerCase() === artifactSha256,
    source_size_matches: Number(source.artifact_bytes) === fs.statSync(artifactPath).size,
    sample_rate_matches: Number(source.sample_rate) === audio.sample_rate,
    },
    technical_quality: {
    duration_is_substantive: audio.duration_seconds >= 10,
    signal_is_non_silent: audio.non_silent,
    peak_is_not_clipped: audio.peak < 0.999,
    clipped_sample_fraction_is_bounded: audio.clipped_sample_fraction <= 0.001,
    dc_offset_is_bounded: Math.abs(audio.dc_offset) < 0.1,
    active_signal_is_substantive: audio.active_sample_fraction >= 0.1,
    },
  };
  return {
    ...proofEnvelope({
      status: 'CAPTAIN_PLANET_MUSIC_TECHNICAL_QUALITY_PROVEN_LISTENING_UNASSESSED',
      needsWorkStatus: 'CAPTAIN_PLANET_MUSIC_ARTIFACT_NEEDS_WORK',
      organ: 'ace_step_music', source, artifactPath, sourceReceiptPath, artifactSha256, checks,
      measurements: { audio },
      unresolved: ['musical_coherence', 'prompt_adherence', 'mix_quality', 'human_listening_review', 'studio_readiness'],
    }),
    source_model_id: source.model_id,
    source_model_revision: source.model_revision,
    source_device: source.device,
    source_generation_seconds: source.generation_seconds,
  };
}

export function verifyImageArtifact({ artifactPath, sourceReceiptPath }) {
  const source = JSON.parse(fs.readFileSync(sourceReceiptPath, 'utf8'));
  const artifactSha256 = sha256File(artifactPath);
  const image = inspectImageArtifact(artifactPath);
  const checks = {
    runtime: {
    source_receipt_contract: source.schema === 'orange.captain_planet.image_artifact.v1',
    source_runtime_status:
      source.status === 'IMAGE_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED'
      && source.artifact_proven === true,
    source_hash_matches: String(source.artifact_sha256 || '').toLowerCase() === artifactSha256,
    source_size_matches: Number(source.artifact_bytes) === fs.statSync(artifactPath).size,
    dimensions_match: Number(source.pixels?.width) === image.width && Number(source.pixels?.height) === image.height,
    },
    technical_quality: {
    substantive_dimensions: image.width >= 512 && image.height >= 512,
    independently_decoded_nonblank: image.nonblank,
    substantive_tonal_range: image.luminance_p95 - image.luminance_p05 >= 40,
    substantive_luminance_variation: image.luminance_stddev >= 15,
    sufficient_tonal_levels: image.unique_luminance_levels >= 64,
    black_clipping_is_bounded: image.black_pixel_fraction < 0.5,
    white_clipping_is_bounded: image.white_pixel_fraction < 0.2,
    },
  };
  return {
    ...proofEnvelope({
      status: 'CAPTAIN_PLANET_IMAGE_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
      needsWorkStatus: 'CAPTAIN_PLANET_IMAGE_ARTIFACT_NEEDS_WORK',
      organ: 'flux2_klein_image', source, artifactPath, sourceReceiptPath, artifactSha256, checks,
      measurements: { image },
      unresolved: ['prompt_adherence', 'object_geometry', 'artifact_detection', 'aesthetic_quality', 'human_visual_review', 'studio_readiness'],
    }),
    source_model_id: source.model,
    source_model_revision: source.model_revisions,
    source_device: source.device,
    source_generation_seconds: source.generation_seconds,
  };
}

export function verifyVideoArtifact({ artifactPath, sourceReceiptPath }) {
  const source = JSON.parse(fs.readFileSync(sourceReceiptPath, 'utf8'));
  const artifactSha256 = sha256File(artifactPath);
  const video = inspectVideoArtifact(artifactPath);
  const checks = {
    runtime: {
    source_receipt_contract: source.schema === 'orange.captain_planet.video_artifact.v1',
    source_runtime_status:
      source.status === 'VIDEO_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED'
      && source.artifact_proven === true,
    source_hash_matches: String(source.artifact_sha256 || '').toLowerCase() === artifactSha256,
    source_size_matches: Number(source.artifact_bytes) === fs.statSync(artifactPath).size,
    source_motion_claim_matches: source.motion_proven === true,
    },
    technical_quality: {
    independently_decoded_motion: video.motion_proven,
    substantive_duration: video.duration_seconds >= 1,
    substantive_dimensions: video.width >= 384 && video.height >= 256,
    substantive_frame_count: video.frame_count >= 24,
    temporal_sampling_is_substantive: video.decoded_sample_frames >= 8,
    moving_samples_are_substantive: video.moving_sample_fraction >= 0.5,
    black_frames_are_bounded: video.black_frame_fraction <= 0.2,
    frames_are_not_flat: video.minimum_frame_luminance_stddev >= 10,
    },
  };
  return {
    ...proofEnvelope({
      status: 'CAPTAIN_PLANET_VIDEO_TECHNICAL_QUALITY_PROVEN_VISUAL_QUALITY_UNASSESSED',
      needsWorkStatus: 'CAPTAIN_PLANET_VIDEO_ARTIFACT_NEEDS_WORK',
      organ: 'ltxv_2b_video', source, artifactPath, sourceReceiptPath, artifactSha256, checks,
      measurements: { video },
      unresolved: ['prompt_adherence', 'temporal_coherence', 'geometry_stability', 'camera_quality', 'human_visual_review', 'long_form_continuity', 'studio_readiness'],
    }),
    source_model_id: source.model,
    source_model_revision: source.model_revision,
    source_device: source.device,
    source_generation_seconds: source.generation_seconds,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      type: { type: 'string' },
      artifact: { type: 'string' },
      source: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!['tts', 'music', 'image', 'video'].includes(values.type) || !values.artifact || !values.source || !values.output) {
    throw new Error('usage: --type tts|music|image|video --artifact PATH --source RECEIPT --output RECEIPT');
  }
  const verifier = {
    tts: verifyTtsArtifact,
    music: verifyMusicArtifact,
    image: verifyImageArtifact,
    video: verifyVideoArtifact,
  }[values.type];
  const receipt = verifier({ artifactPath: values.artifact, sourceReceiptPath: values.source });
  const written = writeChainedJsonReceipt(path.resolve(values.output), receipt);
  console.log(JSON.stringify(written, null, 2));
  if (!written.runtime_execution_proven) process.exitCode = 1;
}
