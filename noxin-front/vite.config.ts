import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
    plugins: [react()],
    server: {
        host: "127.0.0.1",
        proxy: {
            "/api/ai/": {
                target: process.env.NOXIN_DEV_AI_URL ?? "http://127.0.0.1:8090",
                changeOrigin: true,
                secure: true,
                configure(proxy) {
                    proxy.on("proxyReq", (request) => {
                        request.removeHeader("Cookie");
                        request.removeHeader("Authorization");
                        const authorization = process.env.NOXIN_DEV_AI_AUTH;
                        if (authorization) request.setHeader("Authorization", authorization);
                    });
                    proxy.on("proxyRes", (response) => {
                        delete response.headers["www-authenticate"];
                    });
                },
            },
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
