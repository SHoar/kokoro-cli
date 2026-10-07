import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Where the Kokoro model files are cached after the first download.
 * Override with the KOKORO_CLI_CACHE environment variable.
 */
export function defaultCacheDir(): string {
  const override = process.env.KOKORO_CLI_CACHE;
  if (override) return override;

  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Caches", "kokoro-cli");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "kokoro-cli", "Cache");
    default:
      return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "kokoro-cli");
  }
}
