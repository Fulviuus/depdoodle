import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "jsdom", environmentOptions: { jsdom: { url: "http://localhost:1420" } }, include: ["tests/**/*.test.ts"] } });
