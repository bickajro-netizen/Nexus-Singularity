import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GH Pages subpath (repo Nexus-Singularity); preview serves under the same base.
export default defineConfig({
  base: '/Nexus-Singularity/',
  plugins: [react()],
})
