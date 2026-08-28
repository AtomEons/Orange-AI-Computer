import { extractImageLuminance } from '../luminance-ffmpeg.mjs';
import { transformImageWithPhotoreceptor } from '../physical-retinal-transform.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const IMG = path.resolve(__dir, '..', '..', 'fixtures', 'fruits.jpg');
console.log('=== AE Eyes on real image: fruits.jpg ===');
const { data, width, height } = await extractImageLuminance(IMG);
let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
console.log(`luminance extracted: ${width}x${height} (${data.length} bytes, mean=${(sum/data.length).toFixed(1)}/255)`);

const t0 = Date.now();
const { record, photoreceptorMeta } = await transformImageWithPhotoreceptor(
  { data, meta: { width, height, source_kind: 'camera', source_id: 'opencv-fruits.jpg' } },
);
const ms = Date.now() - t0;
console.log(`\ntransform ran in ${ms}ms`);
console.log(`photoreceptor: K=${photoreceptorMeta.K.toFixed(4)}, meanL=${photoreceptorMeta.meanL.toFixed(3)}, saturated=${(photoreceptorMeta.saturatedFraction*100).toFixed(1)}%`);
console.log(`\nretinal_fields:`);
const rf = record.retinal_fields;
console.log(`  gradient_energy_mean:  ${rf.gradient_energy_mean.toFixed(4)}`);
console.log(`  temporal_derivative:   ${rf.temporal_derivative_mean.toFixed(4)} (0 = still image, honest)`);
console.log(`  log_intensity_range:   [${rf.log_intensity_range.map(v=>v.toFixed(3)).join(', ')}]`);
console.log(`  motion_coherence:      ${rf.motion_correlation_coherence.toFixed(3)}`);

console.log(`\nentities detected: ${record.entities.length}`);
for (const e of record.entities) {
  const r = e.region || [0,0,0,0];
  const cx = r[0] + r[2]/2, cy = r[1] + r[3]/2;
  const fx = (cx/width*100).toFixed(0), fy = (cy/height*100).toFixed(0);
  console.log(`  #${e.id}: region=(${r[0]},${r[1]}) size=${r[2]}x${r[3]}  center@ ${fx}%x, ${fy}%y  texture_codes=${e.texture_codes?.length ?? 0}`);
}

console.log(`\ntexture_vocabulary: ${record.texture_vocabulary?.length ?? 0} signatures`);

console.log(`\nhonest notes[]:`);
for (const n of record.notes) console.log(`  · ${n}`);
