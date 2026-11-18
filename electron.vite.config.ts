import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const rendererRoot = realpathSync(resolve(__dirname, 'src/renderer'))

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: rendererRoot,
    build: {
      rollupOptions: {
        input: {
          settings: resolve(rendererRoot, 'settings/index.html'),
          reader: resolve(rendererRoot, 'reader/index.html'),
          preparing: resolve(rendererRoot, 'preparing/index.html')
        }
      }
    }
  }
})
