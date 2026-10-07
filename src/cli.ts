#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  DEFAULT_DTYPE,
  DEFAULT_VOICE,
  MODEL_DTYPES,
  concatSamples,
  defaultCacheDir,
  encodeWav,
  listVoices,
  removeTempFiles,
  resolveVoice,
  speak,
  stopPlayback,
  synthesize,
  unloadModels,
  type DownloadProgress,
  type ModelDtype,
  type SpeakOptions,
  type SpeechChunk,
} from "./index.js";

const HELP = `kokoro-cli - speak text with the Kokoro TTS model, fully on your machine

Usage
  npx kokoro-cli [options] <phrase to say>
  npx kokoro-cli [options] --file <text file>
  echo "some text" | npx kokoro-cli [options]

Voice
  -v, --voice <voice>   Voice id or name: af_heart, bm_george, george... (default: ${DEFAULT_VOICE})
  -s, --speed <n>       Speaking speed from 0.25 to 4, 1 = normal (default: 1)
      --voices          List the available voices

Input and output
  -f, --file <path>     Read the text to speak from a file
  -o, --output <file>   Save the speech as a WAV file instead of playing it
      --play            With --output: play it as well as saving it

Model
      --dtype <type>    Model precision: ${MODEL_DTYPES.join(", ")} (default: ${DEFAULT_DTYPE})
      --model-dir <dir> Use a model folder already on disk; never download

Other
  -q, --quiet           Do not print progress messages
  -h, --help            Show this help
  -V, --version         Show the version

Examples
  npx kokoro-cli Hello from Kokoro
  npx kokoro-cli -v george -s 1.1 "Good evening. Dinner is served."
  npx kokoro-cli -o hello.wav Hello there
  npx kokoro-cli -f story.txt -v bella -o story.wav --play

The model (about 92 MB) is downloaded once on first run and cached in
  ${defaultCacheDir()}
After that kokoro-cli works offline. Speech is always generated locally.
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/** An error whose message is shown to the user as it is. */
class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function printVoices(): void {
  const rows = listVoices().map((v) => [v.id, v.name, v.language, v.gender, v.overallGrade]);
  const header = ["ID", "NAME", "LANGUAGE", "GENDER", "GRADE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  process.stdout.write([line(header), ...rows.map(line)].join("\n") + "\n");
}

/** Shows a single updating line while the model downloads; silent when it is already cached. */
function downloadReporter(quiet: boolean): { onProgress: (p: DownloadProgress) => void; done: () => void } {
  const tty = process.stderr.isTTY;
  let shown = false;
  let lastPercent = -1;
  return {
    onProgress(p) {
      // Only the model weights are worth reporting; a cached model reports 100% straight away.
      if (quiet || !p.file.endsWith(".onnx") || !(p.total > 0)) return;
      const percent = Math.floor(p.percent);
      if (!shown && percent >= 100) return;
      if (!shown) {
        shown = true;
        if (!tty) process.stderr.write("Downloading the Kokoro model (first run only)...\n");
      }
      if (tty && percent !== lastPercent) {
        lastPercent = percent;
        const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
        process.stderr.write(`\rDownloading the Kokoro model (first run only): ${percent}% of ${mb(p.total)} MB `);
      }
    },
    done() {
      if (shown && tty) process.stderr.write("\r\x1b[K");
    },
  };
}

/** Runs the command and returns the exit code. */
async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        voice: { type: "string", short: "v" },
        speed: { type: "string", short: "s" },
        output: { type: "string", short: "o" },
        file: { type: "string", short: "f" },
        play: { type: "boolean" },
        dtype: { type: "string" },
        "model-dir": { type: "string" },
        voices: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    });
  } catch (err) {
    fail(`${(err as Error).message}\nRun "kokoro-cli --help" for usage.`);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(version() + "\n");
    return 0;
  }
  if (values.voices) {
    printVoices();
    return 0;
  }

  if (values.file !== undefined && positionals.length > 0) {
    fail("Give either a phrase or --file, not both.");
  }
  if (values.play && !values.output) {
    fail("--play only applies together with --output (without --output the speech is always played).");
  }

  let text: string;
  if (values.file !== undefined) {
    try {
      text = await readFile(resolve(values.file), "utf8");
    } catch (err) {
      fail(`Could not read ${values.file}: ${(err as Error).message}`);
    }
    if (!text.trim()) fail(`${values.file} is empty.`);
  } else {
    text = positionals.length > 0 ? positionals.join(" ") : await readStdin();
  }
  text = text.trim();
  if (!text) {
    process.stderr.write(HELP);
    return 1;
  }

  const output = values.output === undefined ? undefined : resolve(values.output);
  if (output) {
    const ext = extname(output).toLowerCase();
    if (ext && ext !== ".wav") {
      fail(`--output writes WAV audio, so the file name should end in .wav (got "${ext}").`);
    }
  }

  let voice: string;
  try {
    voice = resolveVoice(values.voice ?? process.env.KOKORO_CLI_VOICE ?? DEFAULT_VOICE);
  } catch (err) {
    fail(`${(err as Error).message}\nRun "kokoro-cli --voices" to see them with names and languages.`);
  }

  const speed = values.speed === undefined ? 1 : Number(values.speed);
  if (Number.isNaN(speed)) fail(`--speed must be a number (got "${values.speed}").`);
  if (values.dtype && !MODEL_DTYPES.includes(values.dtype as ModelDtype)) {
    fail(`--dtype must be one of: ${MODEL_DTYPES.join(", ")}`);
  }

  const reporter = downloadReporter(Boolean(values.quiet));
  const options: SpeakOptions = {
    voice,
    speed,
    dtype: values.dtype as ModelDtype | undefined,
    modelDir: values["model-dir"] ?? process.env.KOKORO_CLI_MODEL_DIR,
    onProgress: reporter.onProgress,
  };

  process.once("SIGINT", () => {
    stopPlayback();
    removeTempFiles();
    // End through the signal itself. process.exit() here would run ONNX Runtime's
    // teardown in the middle of its work, which aborts on macOS.
    finished = true;
    process.kill(process.pid, "SIGINT");
  });

  const save = async (samples: Float32Array, sampleRate: number, file: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, encodeWav(samples, sampleRate));
    if (!values.quiet) {
      const seconds = (samples.length / sampleRate).toFixed(1);
      process.stderr.write(`Saved ${seconds}s of speech to ${file}\n`);
    }
  };

  try {
    if (output && values.play) {
      // Speak and keep a copy of every sentence for the file.
      const chunks: SpeechChunk[] = [];
      await speak(text, { ...options, onChunk: (chunk) => chunks.push(chunk) });
      reporter.done();
      await save(concatSamples(chunks.map((c) => c.samples)), chunks[0]?.sampleRate ?? 24000, output);
    } else if (output) {
      const speech = await synthesize(text, options);
      reporter.done();
      await save(speech.samples, speech.sampleRate, output);
    } else {
      await speak(text, options);
      reporter.done();
    }
  } catch (err) {
    reporter.done();
    fail(describe(err, options));
  }
  return 0;
}

function describe(err: unknown, options: SpeakOptions): string {
  const message = err instanceof Error ? err.message : String(err);
  if (options.modelDir && /local_files_only|not found locally|Could not locate file/i.test(message)) {
    return `No usable model in ${resolve(options.modelDir)} (expected config.json, tokenizer.json and an onnx/ folder).\n${message}`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|(Unauthorized|Forbidden) access|Could not locate file/i.test(message)) {
    return (
      `Could not download the Kokoro model. An internet connection is needed the first time only; ` +
      `after that kokoro-cli runs offline.\n${message}`
    );
  }
  return message;
}

let finished = false;

/**
 * Ends the process without process.exit(): the model is released first and the event
 * loop is left to drain. A hard exit while ONNX Runtime sessions are alive aborts on
 * macOS with "mutex lock failed: Invalid argument".
 */
async function shutdown(code: number): Promise<void> {
  finished = true;
  process.exitCode = code;
  await unloadModels();
  // Safety net only: if something still holds the event loop open, do not hang.
  setTimeout(() => process.exit(code), 3000).unref();
}

function report(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`kokoro-cli: ${message}\n`);
}

// The espeak phonemizer inside kokoro-js installs handlers that rethrow any stray error
// together with a megabyte of minified source. Replace them with a one-line report.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.removeAllListeners(event);
  process.on(event, (err: unknown) => {
    report(err);
    void shutdown(1);
  });
}

// Never end quietly with success if the work was cut short.
process.on("exit", (code) => {
  if (!finished && code === 0) {
    process.stderr.write("kokoro-cli: stopped before the speech was finished.\n");
    process.exitCode = 1;
  }
});

main().then(
  (code) => shutdown(code),
  (err) => {
    report(err);
    return shutdown(1);
  },
);
