import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    host: true,   // 允許區域網路存取（公司內網開發用）
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    // 移除 production console.log（保留 console.warn / error）
    minify: 'esbuild',
    rollupOptions: {
      output: {
        // 分割 vendor chunk，讓使用者快取命中率更高
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },

  // Vitest（未來加單元測試用）
  // test: { globals: true, environment: 'jsdom' },
})
