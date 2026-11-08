import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// `npm run dev`        -> http://localhost:5173 (mic works on localhost)
// `npm run dev:https`  -> https://<your-LAN-IP>:5173 so phones on the same Wi-Fi can use the mic
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    host: mode === 'https' ? true : 'localhost',
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
}))
