import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  target: "es2022",
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: false,
  splitting: false,
});
