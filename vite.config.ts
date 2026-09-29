import { execSync } from "node:child_process";

import { defineConfig, type Plugin } from "vite-plus";

const WASM_BUILD = "wasm-pack build wasm --target web --release";

/** Rebuild the wasm pkg when the Rust side changes; Vite then reloads the page. */
function wasmHotRebuild(): Plugin {
  let building = false;
  return {
    name: "wasm-hot-rebuild",
    configureServer(server) {
      server.watcher.on("change", (path) => {
        if (building || !/wasm\/(src\/.*\.rs|Cargo\.(toml|lock))$/.test(path)) return;
        building = true;
        server.config.logger.info("Rebuilding WASM...", { timestamp: true });
        try {
          execSync(WASM_BUILD, { stdio: "inherit" });
          server.config.logger.info("WASM rebuild complete", { timestamp: true });
        } catch {
          server.config.logger.error("WASM rebuild failed", { timestamp: true });
        } finally {
          building = false;
        }
      });
    },
  };
}

// Slidev merges this file into its own Vite config.
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    // The markdown formatter splits Slidev's per-slide frontmatter
    // (`---` / `layout: …` / `---`) with blank lines, which breaks it.
    ignorePatterns: ["slides.md"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
  },
  run: {
    tasks: {
      "wasm:build": {
        command: WASM_BUILD,
        // Uncached: with the [patch] in wasm/Cargo.toml pointing oxifoc-core
        // at a local checkout, vp's input globs cannot see its changes. An
        // incremental cargo build is fast anyway.
        cache: false,
      },
    },
  },
  plugins: [wasmHotRebuild()],
  server: {
    watch: {
      ignored: ["**/wasm/target/**"],
    },
  },
});
