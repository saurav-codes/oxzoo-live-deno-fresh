import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";

export default defineConfig({
  plugins: [fresh()],
  define: { __BUILT_AT__: JSON.stringify(new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) },
});
