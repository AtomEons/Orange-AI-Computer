export const DEFAULT_ORANGEBRAIN_URL = 'http://127.0.0.1:1337';

export function resolveOrangeBrainUrl(env = process.env) {
  const configured = typeof env.ORANGE5_ORANGEBRAIN_URL === 'string'
    ? env.ORANGE5_ORANGEBRAIN_URL.trim()
    : '';
  return (configured || DEFAULT_ORANGEBRAIN_URL).replace(/\/+$/, '');
}
