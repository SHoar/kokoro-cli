import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { env } from "@huggingface/transformers";
import { KokoroTTS, TextSplitterStream, type GenerateOptions } from "kokoro-js";

import { defaultCacheDir } from "./paths.js";
import { playFile } from "./player.js";
import { concatSamples, encodeWav } from "./wav.js";

export { defaultCacheDir } from "./paths.js";
export { NoAudioPlayerError, playFile, stopPlayback } from "./player.js";
export { concatSamples, encodeWav } from "./wav.js";

/** The ONNX export of Kokoro-82M v1.0 that kokoro-js is built for. */
export const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_VOICE = "af_heart";
export const DEFAULT_DTYPE: ModelDtype = "q8";

/**
 * A copy of the default model (q8) on GitHub. It is used when Hugging Face cannot be
 * reached, for example from a network that blocks it.
 */
export const DEFAULT_MIRROR_URL = "https://github.com/arsensalmanov/kokoro-cli/releases/download/model-v1.0/";

/** The mirrored files: release asset name, path in the model folder, and SHA-256. */
const MIRROR_FILES = [
  { asset: "config.json", path: "config.json", sha256: "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f" },
  { asset: "tokenizer.json", path: "tokenizer.json", sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34" },
  { asset: "tokenizer_config.json", path: "tokenizer_config.json", sha256: "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20" },
  { asset: "model_quantized.onnx", path: "onnx/model_quantized.onnx", sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478" },
] as const;

/** Model precision. Smaller is faster to download and load; fp32 is the reference quality. */
export type ModelDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
export const MODEL_DTYPES: readonly ModelDtype[] = ["fp32", "fp16", "q8", "q4", "q4f16"];

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: string;
  traits?: string;
  overallGrade: string;
}

export interface DownloadProgress {
  file: string;
  loaded: number;
  total: number;
  /** 0-100 */
  percent: number;
}

export interface LoadOptions {
  /** Model precision. Default: "q8" (about 92 MB). */
  dtype?: ModelDtype;
  /** Hugging Face model id to download on first use. */
  modelId?: string;
  /**
   * Folder that already contains the model (config.json, tokenizer.json, onnx/...).
   * When set, nothing is ever downloaded.
   */
  modelDir?: string;
  /** Where downloaded model files are kept. Default: the per-user cache folder. */
  cacheDir?: string;
  /**
   * Base URL of a copy of the default model, used when Hugging Face cannot be reached.
   * Default: DEFAULT_MIRROR_URL. Set to false to disable the fallback.
   */
  mirror?: string | false;
  /** Called while model files are being downloaded (first run only). */
  onProgress?: (progress: DownloadProgress) => void;
}

export interface SpeakOptions extends LoadOptions {
  /** Voice id ("af_heart", "bm_george") or just its name ("george"). See listVoices(). */
  voice?: string;
  /** Speaking speed, 1 = normal. */
  speed?: number;
}

export interface SpeechChunk {
  /** The sentence this chunk was generated from. */
  text: string;
  /** Mono float samples in the range -1..1. */
  samples: Float32Array;
  sampleRate: number;
}

export interface Speech {
  samples: Float32Array;
  sampleRate: number;
  /** The audio as a 16-bit PCM WAV file. */
  toWav(): Buffer;
}

/** All voices this version of Kokoro can speak with. Does not load the model. */
export function listVoices(): VoiceInfo[] {
  // `voices` is a plain getter on the class that returns kokoro-js's static table.
  const table = KokoroTTS.prototype.voices as Record<string, Omit<VoiceInfo, "id">>;
  return Object.entries(table).map(([id, info]) => ({ id, ...info }));
}

/**
 * Turn what the user typed into a voice id. Accepts the id ("bm_george") or just the
 * name ("george", "George"). Throws with the list of voices when nothing matches.
 */
export function resolveVoice(voice: string): string {
  const voices = listVoices();
  const wanted = voice.trim().toLowerCase();
  const match = voices.find((v) => v.id === wanted) ?? voices.find((v) => v.name.toLowerCase() === wanted);
  if (!match) {
    throw new Error(`Unknown voice "${voice}". Available voices: ${voices.map((v) => v.id).join(", ")}`);
  }
  return match.id;
}

function assertSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw new Error(`Speed must be a number between 0.25 and 4 (got ${speed}).`);
  }
}

const loaded = new Map<string, Promise<KokoroTTS>>();

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function mirrorBase(options: LoadOptions): string | undefined {
  if (options.mirror === false) return undefined;
  const value = options.mirror ?? process.env.KOKORO_CLI_MIRROR?.trim() ?? DEFAULT_MIRROR_URL;
  if (!value || /^(off|false|0|none)$/i.test(value)) return undefined;
  return value.endsWith("/") ? value : value + "/";
}

/**
 * Download the default model from the mirror into the cache, in the same layout that
 * the Hugging Face download uses. Every file is checked against its SHA-256.
 */
async function downloadFromMirror(base: string, modelRoot: string, onProgress?: (p: DownloadProgress) => void): Promise<void> {
  for (const file of MIRROR_FILES) {
    const dest = join(modelRoot, file.path);
    const present = await stat(dest).then(
      () => true,
      () => false,
    );
    if (present && (await sha256Of(dest)) === file.sha256) continue;

    const url = base + file.asset;
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`${url} answered HTTP ${response.status}`);

    const total = Number(response.headers.get("content-length")) || 0;
    const hash = createHash("sha256");
    let received = 0;
    const partial = dest + ".download";
    await mkdir(dirname(dest), { recursive: true });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source) {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            hash.update(chunk);
            received += chunk.length;
            if (total) onProgress?.({ file: file.path, loaded: received, total, percent: (received / total) * 100 });
            yield chunk;
          }
        },
        createWriteStream(partial),
      );
      if (hash.digest("hex") !== file.sha256) throw new Error(`${url} does not match the expected SHA-256`);
      await rename(partial, dest);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Load the Kokoro model. The result is memoised, so calling this repeatedly is cheap.
 * On first use the model files are downloaded once and cached on disk; after that
 * everything runs offline. If Hugging Face cannot be reached, the default model is
 * downloaded from the GitHub mirror instead.
 */
export function loadModel(options: LoadOptions = {}): Promise<KokoroTTS> {
  const dtype = options.dtype ?? DEFAULT_DTYPE;
  if (!MODEL_DTYPES.includes(dtype)) {
    throw new Error(`Unknown dtype "${dtype}". Use one of: ${MODEL_DTYPES.join(", ")}`);
  }

  let modelId = options.modelId ?? DEFAULT_MODEL_ID;
  let cacheDir: string | undefined;
  if (options.modelDir) {
    const dir = resolve(options.modelDir);
    env.localModelPath = dirname(dir) + sep;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    modelId = basename(dir);
  } else {
    cacheDir = options.cacheDir ?? defaultCacheDir();
    env.cacheDir = cacheDir;
    // Same convention as the Hugging Face tools: HF_ENDPOINT selects a mirror for the one-time download.
    const endpoint = process.env.HF_ENDPOINT?.trim();
    if (endpoint) env.remoteHost = endpoint.endsWith("/") ? endpoint : endpoint + "/";
  }

  const key = `${options.modelDir ? resolve(options.modelDir) : modelId}|${dtype}`;
  let tts = loaded.get(key);
  if (!tts) {
    const { onProgress } = options;
    const fromPretrained = () =>
      KokoroTTS.from_pretrained(modelId, {
        dtype,
        device: "cpu",
        progress_callback: onProgress
          ? (info) => {
              if (info.status !== "progress") return;
              onProgress({ file: info.file, loaded: info.loaded, total: info.total, percent: info.progress });
            }
          : undefined,
      });

    // The mirror holds the default model only.
    const base = modelId === DEFAULT_MODEL_ID && dtype === "q8" ? mirrorBase(options) : undefined;
    const modelRoot = cacheDir === undefined ? undefined : join(cacheDir, modelId);

    tts = fromPretrained().catch(async (err: unknown) => {
      if (base === undefined || modelRoot === undefined) throw err;
      try {
        await downloadFromMirror(base, modelRoot, onProgress);
      } catch (mirrorErr) {
        throw new Error(
          `Could not download the model.\n  Hugging Face: ${messageOf(err)}\n  GitHub mirror: ${messageOf(mirrorErr)}`,
        );
      }
      // The files are now in the cache, so this load needs no network.
      return fromPretrained();
    });
    loaded.set(key, tts);
    tts.catch(() => loaded.delete(key));
  }
  return tts;
}

/**
 * Release the loaded model and its ONNX Runtime sessions.
 * Call this before the process ends: on macOS, ending the process while a session is
 * still alive makes ONNX Runtime abort with "mutex lock failed: Invalid argument".
 */
export async function unloadModels(): Promise<void> {
  const pending = [...loaded.values()];
  loaded.clear();
  for (const p of pending) {
    try {
      await (await p).model.dispose();
    } catch {
      // The model never finished loading or is already released.
    }
  }
}

const tempDirs = new Set<string>();

/** Remove the temporary audio files of a speak() call that is still in progress. */
export function removeTempFiles(): void {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

/**
 * Generate speech sentence by sentence. Each chunk is yielded as soon as it is ready,
 * so playback can start before long texts have finished generating.
 */
export async function* synthesizeStream(text: string, options: SpeakOptions = {}): AsyncGenerator<SpeechChunk, void, void> {
  const voice = resolveVoice(options.voice ?? DEFAULT_VOICE);
  const speed = options.speed ?? 1;
  assertSpeed(speed);
  if (!text.trim()) return;

  const tts = await loadModel(options);

  // kokoro-js never closes the splitter it creates for plain strings, so its stream would
  // wait forever (and drop a last sentence without punctuation). Feed it a closed one.
  const sentences = new TextSplitterStream();
  sentences.push(text);
  sentences.close();

  const stream = tts.stream(sentences, { voice: voice as GenerateOptions["voice"], speed });
  for await (const { text: sentence, audio } of stream) {
    yield { text: sentence, samples: audio.audio, sampleRate: audio.sampling_rate };
  }
}

/** Generate speech for the whole text and return it as one piece of audio. */
export async function synthesize(text: string, options: SpeakOptions = {}): Promise<Speech> {
  const chunks: Float32Array[] = [];
  let sampleRate = 24000;
  for await (const chunk of synthesizeStream(text, options)) {
    chunks.push(chunk.samples);
    sampleRate = chunk.sampleRate;
  }
  const samples = concatSamples(chunks);
  return { samples, sampleRate, toWav: () => encodeWav(samples, sampleRate) };
}

/** Generate speech and write it to a WAV file. */
export async function saveSpeech(text: string, file: string, options: SpeakOptions = {}): Promise<Speech> {
  const speech = await synthesize(text, options);
  await writeFile(file, speech.toWav());
  return speech;
}

/**
 * Say the text out loud through the system's speakers.
 * Sentences are played as they are generated; resolves when playback has finished.
 */
export async function speak(
  text: string,
  options: SpeakOptions & {
    /** Called with each sentence's audio as it is generated, e.g. to keep a copy. */
    onChunk?: (chunk: SpeechChunk) => void;
  } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kokoro-cli-"));
  // Also clean up if the process is ended early (Ctrl+C) while we are speaking.
  tempDirs.add(dir);
  const removeOnExit = () => rmSync(dir, { recursive: true, force: true });
  process.once("exit", removeOnExit);
  let playback: Promise<void> = Promise.resolve();
  let playbackError: unknown;
  let index = 0;

  try {
    for await (const chunk of synthesizeStream(text, options)) {
      if (playbackError) break;
      options.onChunk?.(chunk);
      const file = join(dir, `chunk-${index++}.wav`);
      await writeFile(file, encodeWav(chunk.samples, chunk.sampleRate));
      // Queue this sentence behind the previous one while the next is being generated.
      playback = playback
        .then(() => (playbackError ? undefined : playFile(file)))
        .catch((err: unknown) => {
          playbackError = err;
        });
    }
    await playback;
    if (playbackError) throw playbackError;
  } finally {
    await playback;
    process.off("exit", removeOnExit);
    tempDirs.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }
}
