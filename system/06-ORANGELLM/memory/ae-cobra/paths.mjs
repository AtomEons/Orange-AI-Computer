import path from 'node:path';
import { homedir } from 'node:os';

export function canonicalFluxRoot(env = process.env, platform = process.platform, home = homedir()) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const explicit = env.AE_COBRA_FLUX_ROOT || env.AE_FLUX_ROOT;
  if (explicit) return pathApi.resolve(explicit);
  if (platform === 'win32') return pathApi.join(home, 'OrangeBox-Data', 'orange5', 'ae-cobra-flux');
  return '/mnt/ae_flux';
}

export const CANONICAL_FLUX_ROOT = canonicalFluxRoot();
