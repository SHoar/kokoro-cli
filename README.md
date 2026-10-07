# kokoro-cli

`kokoro-cli` changes text into speech on your computer.
It uses the [Kokoro](https://kokorottsai.com) text-to-speech model.
It does not send your text to a server.

```sh
npx kokoro-cli Hello from Kokoro
```

## Demo

[![kokoro-cli in a terminal](https://raw.githubusercontent.com/arsensalmanov/kokoro-cli/main/media/demo.gif)](https://github.com/arsensalmanov/kokoro-cli/blob/main/media/demo.mp4)

The image has no sound. [Play the video with sound.](https://github.com/arsensalmanov/kokoro-cli/blob/main/media/demo.mp4)

## Requirements

- Node.js 18.17 or later.
- An internet connection for the first use only.
- An audio player. macOS and Windows have one. On Linux, install one of these: `paplay`, `pw-play`, `aplay`, `ffplay`, `play`, `mpv`.

## First use

The first command downloads the model (approximately 92 MB) from Hugging Face.
The tool keeps the model in a cache folder.
After the download, the tool operates without an internet connection.

If the tool cannot connect to Hugging Face, it downloads the same model from the [GitHub releases](https://github.com/arsensalmanov/kokoro-cli/releases/tag/model-v1.0) of this project.
The tool makes sure that each file has the correct SHA-256 checksum.

| System  | Cache folder                      |
| ------- | --------------------------------- |
| macOS   | `~/Library/Caches/kokoro-cli`     |
| Linux   | `~/.cache/kokoro-cli`             |
| Windows | `%LOCALAPPDATA%\kokoro-cli\Cache` |

## Use

Speak a phrase:

```sh
npx kokoro-cli Hello from Kokoro
```

Select a voice and a speed:

```sh
npx kokoro-cli -v george -s 1.1 "Good evening. Dinner is served."
```

Save the speech to a file:

```sh
npx kokoro-cli -o hello.wav Hello there
```

Save the speech and play it:

```sh
npx kokoro-cli -o hello.wav --play Hello there
```

Read the text from a file:

```sh
npx kokoro-cli -f story.txt
```

Read the text from a different command:

```sh
echo "Text from a pipe" | npx kokoro-cli
```

Show the voices:

```sh
npx kokoro-cli --voices
```

If the phrase contains special shell characters (`'`, `!`, `?`, `&`), put it in quotation marks.

## Options

| Option                | Function                                                           |
| --------------------- | ------------------------------------------------------------------ |
| `-v, --voice <voice>` | Selects the voice. The default is `af_heart`.                      |
| `-s, --speed <n>`     | Sets the speed from `0.25` to `4`. The default is `1`.             |
| `--voices`            | Shows the voices.                                                  |
| `-f, --file <path>`   | Reads the text from a file.                                        |
| `-o, --output <file>` | Saves the speech as a WAV file. The tool does not play the speech. |
| `--play`              | Plays the speech when you use `--output`.                          |
| `--dtype <type>`      | Selects the model precision. The default is `q8`.                  |
| `--model-dir <dir>`   | Uses a model folder on your disk. The tool downloads nothing.      |
| `-q, --quiet`         | Hides the progress messages.                                       |
| `-h, --help`          | Shows the help.                                                    |
| `-V, --version`       | Shows the version.                                                 |

The values for `--dtype` are `fp32`, `fp16`, `q8`, `q4` and `q4f16`.
`fp32` gives the best quality and is the largest download.

## Voices

There are 28 voices. All voices speak English.

| Prefix | Voices                    |
| ------ | ------------------------- |
| `af_`  | American English, female. |
| `am_`  | American English, male.   |
| `bf_`  | British English, female.  |
| `bm_`  | British English, male.    |

You can write the full ID or only the name. `george` and `bm_george` select the same voice.

Other languages are not available.

## Environment variables

| Variable               | Function                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `KOKORO_CLI_VOICE`     | Sets the default voice.                                                                 |
| `KOKORO_CLI_CACHE`     | Sets the cache folder.                                                                  |
| `KOKORO_CLI_MODEL_DIR` | Sets the model folder. It has the same function as `--model-dir`.                       |
| `KOKORO_CLI_PLAYER`    | Sets the command that plays a WAV file. The tool adds the file path as the last argument. |
| `HF_ENDPOINT`          | Sets a Hugging Face mirror for the download.                                            |
| `KOKORO_CLI_MIRROR`    | Sets the address of the model copy on GitHub. The value `off` stops this function.      |

## Use without an internet connection

1. On a computer with an internet connection, open [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX).
2. Download `config.json`, `tokenizer.json`, `tokenizer_config.json` and `onnx/model_quantized.onnx`.
3. Put the files in one folder. Keep `model_quantized.onnx` in the `onnx` subfolder.
4. Copy the folder to the target computer.
5. Give the folder to the tool:

```sh
npx kokoro-cli --model-dir ./Kokoro-82M-v1.0-ONNX Hello
```

## Use in your code

```ts
import { speak, synthesize, saveSpeech, synthesizeStream, listVoices } from "kokoro-cli";

// Play the speech.
await speak("Hello from Kokoro", { voice: "bella", speed: 1 });

// Get the audio data.
const speech = await synthesize("Only the audio.");
speech.samples;    // Float32Array, one channel
speech.sampleRate; // 24000
speech.toWav();    // Buffer, 16-bit WAV

// Save the speech to a file.
await saveSpeech("Save this text.", "out.wav", { voice: "bm_george" });

// Get the audio for each sentence.
for await (const chunk of synthesizeStream("One sentence. Then a second sentence.")) {
  console.log(chunk.text, chunk.samples.length);
}

// Get the list of voices.
console.log(listVoices());
```

The package is an ES module.

## Development

```sh
npm install
npm run build
node dist/cli.js Hello
```

## License

This package has the MIT license.
The Kokoro model and [`kokoro-js`](https://www.npmjs.com/package/kokoro-js) have the Apache-2.0 license.
