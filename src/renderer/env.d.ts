import type { KokoroApi } from '../shared/types'

declare global {
  interface Window {
    kokoro: KokoroApi
  }
}
