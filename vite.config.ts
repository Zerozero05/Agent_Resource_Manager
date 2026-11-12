import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()], clearScreen:false, server:{port:1420, strictPort:true}, envPrefix:['VITE_','TAURI_ENV_'],
  build: {
    rollupOptions: {
      output: {
        // Shared UI libraries must not be pulled back through the entry chunk by lazy pages.
        manualChunks(id) {
          const path = id.replace(/\\/g, '/');
          if (/\/node_modules\/(?:react|react-dom|scheduler|lucide-react|@tauri-apps\/(?:api|plugin-dialog|plugin-opener))\//.test(path)) return 'ui-runtime';
        },
      },
    },
  },
});
