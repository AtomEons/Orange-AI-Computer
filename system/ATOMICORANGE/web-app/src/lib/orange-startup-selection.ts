import { ORANGE_BRAIN_PROVIDER } from './orange-crossing'

/**
 * OrangeBrain is a remote control-plane provider, not a locally preloaded
 * model. Disabling local preload must never clear the governed Orange crossing.
 */
export function shouldClearStartupModelSelection(
  preloadModelOnStartup: boolean,
  selectedProvider: string
): boolean {
  return !preloadModelOnStartup && selectedProvider !== ORANGE_BRAIN_PROVIDER
}
