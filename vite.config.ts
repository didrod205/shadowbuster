import { defineConfig } from "vite";

// The site reuses the exact pure core from src/ and builds to /docs for GitHub
// Pages. Everything runs client-side — no backend, no upload, no network. The
// dropped file is read with FileReader and parsed entirely in the browser.
export default defineConfig({
  root: "web",
  base: "./",
  build: {
    outDir: "../docs",
    emptyOutDir: true,
    target: "es2022",
  },
});
