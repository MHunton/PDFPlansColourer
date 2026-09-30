import { defineConfig } from "vite";

// Relative base so the build works from any sub-path (GitHub Pages project site, SharePoint, file share).
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      output: {
        // pdf.js worker ships as .mjs; many static servers (nginx default, IIS) send .mjs as octet-stream and
        // browsers then refuse to start it as a module worker. Emit it as .js so every host serves JS MIME.
        assetFileNames: (a) => (a.names?.[0] ?? "").endsWith(".mjs") ? "assets/[name]-[hash].js" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
