import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
    plugins: [react()],
    server: {
        host: true,
        proxy: {
            "/api": {
                target: process.env.NOXIN_DEV_BACKEND_URL ?? "http://127.0.0.1:8002",
                changeOrigin: true,
            },
        },
    },
    base: './',
    build: {
        sourcemap: mode === "developement",
    },
    test: {
        globals: true,
        environment: 'jsdom'
    }
}));
