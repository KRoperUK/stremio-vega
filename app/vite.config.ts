import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built app works served from any path on the server.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {outDir: 'dist'},
});
