import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const api = `ws://localhost:${process.env.PORT ?? 8792}` // same PORT as server/index.ts
const http = api.replace('ws:', 'http:')

export default defineConfig({
  plugins: [react()],
  server: { port: 5181, proxy: { '/ws': { target: api, ws: true }, '/assets': http } },
})
