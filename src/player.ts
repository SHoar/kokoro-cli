import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

interface PlayerCommand {
  cmd: string;
  args: (file: string) => string[];
}

export class NoAudioPlayerError extends Error {
  constructor(tried: string[]) {
    super(
      `No working audio player found (tried: ${tried.join(", ")}). ` +
        `Install one of them, set KOKORO_CLI_PLAYER to a command that plays a WAV file, ` +
        `or use --output <file.wav> to save the speech instead.`,
    );
    this.name = "NoAudioPlayerError";
  }
}

function candidates(): PlayerCommand[] {
  // KOKORO_CLI_PLAYER="mpv --no-video" -> the WAV path is appended as the last argument.
  const custom = process.env.KOKORO_CLI_PLAYER?.trim();
  if (custom) {
    const [cmd, ...rest] = custom.split(/\s+/);
    return [{ cmd: cmd!, args: (f) => [...rest, f] }];
  }

  const ffplay: PlayerCommand = { cmd: "ffplay", args: (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f] };
  const mpv: PlayerCommand = { cmd: "mpv", args: (f) => ["--no-video", "--really-quiet", f] };

  switch (platform()) {
    case "darwin":
      return [{ cmd: "afplay", args: (f) => [f] }, ffplay, mpv];
    case "win32":
      return [
        {
          cmd: "powershell.exe",
          args: (f) => [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(New-Object System.Media.SoundPlayer '${f.replace(/'/g, "''")}').PlaySync()`,
          ],
        },
        ffplay,
        mpv,
      ];
    default:
      return [
        { cmd: "paplay", args: (f) => [f] },
        { cmd: "pw-play", args: (f) => [f] },
        { cmd: "aplay", args: (f) => ["-q", f] },
        ffplay,
        { cmd: "play", args: (f) => ["-q", f] }, // SoX
        mpv,
      ];
  }
}

let working: PlayerCommand | undefined;
let current: ChildProcess | undefined;

function run(player: PlayerCommand, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(player.cmd, player.args(file), { stdio: "ignore", windowsHide: true });
    current = child;
    child.once("error", (err) => {
      current = undefined;
      reject(err);
    });
    child.once("exit", (code, signal) => {
      current = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${player.cmd} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

/**
 * Play a WAV file through the system's audio output and resolve when it finishes.
 * The first player that works is remembered for subsequent calls.
 */
export async function playFile(file: string): Promise<void> {
  if (working) return run(working, file);

  const tried: string[] = [];
  for (const player of candidates()) {
    tried.push(player.cmd);
    try {
      await run(player, file);
      working = player;
      return;
    } catch {
      // Not installed, or installed but unable to reach an audio device: try the next one.
    }
  }
  throw new NoAudioPlayerError(tried);
}

/** Stop whatever is currently playing (used on Ctrl+C). */
export function stopPlayback(): void {
  current?.kill();
  current = undefined;
}
