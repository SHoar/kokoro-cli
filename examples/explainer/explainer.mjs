// Narrated explainer video: scenes.json -> out.mp4
// Voice: kokoro-cli (local). Pictures: one HTML page drawn at each frame time. Join: ffmpeg.
// Usage: node explainer.mjs scenes.json out.mp4 [--stills]
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { saveSpeech, unloadModels } from "kokoro-cli";

const [specFile, outFile = "out.mp4"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const STILLS = process.argv.includes("--stills");
if (!specFile) throw new Error("Usage: node explainer.mjs scenes.json out.mp4 [--stills]");
const spec = JSON.parse(readFileSync(specFile, "utf8"));
const work = join(dirname(resolve(outFile)), ".explainer");
mkdirSync(work, { recursive: true });

const FPS = 30, W = 1920, H = 1080;
const LEAD = 0.45, TAIL = 0.55, FADE = 0.4, CPS = 24;
const accent = spec.accent ?? "#7c3aed";

// ---------- 1. narration: one WAV per scene, real durations drive the timeline ----------
function envelope(file) {
  const b = readFileSync(file), rate = b.readUInt32LE(24), n = (b.length - 44) / 2, hop = Math.round(rate / 10), env = [];
  for (let i = 0; i < n; i += hop) {
    let sum = 0; const end = Math.min(i + hop, n);
    for (let j = i; j < end; j++) { const v = b.readInt16LE(44 + j * 2) / 32768; sum += v * v; }
    env.push(Math.sqrt(sum / (end - i)));
  }
  const max = Math.max(...env, 1e-6);
  return env.map((v) => +Math.pow(v / max, 0.6).toFixed(3));
}
let t = 0;
const scenes = [];
for (const [i, sc] of spec.scenes.entries()) {
  const scene = { ...sc, start: t, say: (sc.say ?? "").trim(), dur: 0, env: [] };
  if (scene.say) {
    scene.wav = join(work, `scene-${i}.wav`);
    const speech = await saveSpeech(scene.say, scene.wav, { voice: sc.voice ?? spec.voice ?? "af_heart", speed: sc.speed ?? spec.speed ?? 1 });
    scene.dur = speech.samples.length / speech.sampleRate;
    scene.env = envelope(scene.wav);
  }
  // Terminal scenes: typing must fit, so the scene is as long as the longer of voice and typing.
  let typed = 0;
  if (sc.type === "terminal") {
    let ct = LEAD;
    scene.lines = (sc.lines ?? []).map((l) => {
      if (l.cmd !== undefined) { const at = ct; ct += l.cmd.length / CPS + 0.5; return { cmd: l.cmd, at, done: ct - 0.2 }; }
      const at = ct; ct += 0.5; return { out: l.out, at };
    });
    typed = ct;
  }
  scene.len = Math.max(3, LEAD + scene.dur + TAIL, typed + 1);
  scene.end = scene.start + scene.len;
  t = scene.end;
  scenes.push(scene);
  console.log(`scene ${i + 1}/${spec.scenes.length} ${sc.type.padEnd(8)} ${scene.len.toFixed(1)}s  voice ${scene.dur.toFixed(1)}s`);
}
await unloadModels();
const TOTAL = t;

// ---------- 2. the page: window.setTime(t) draws the frame for time t ----------
const fontFile = (pkg, name) => createRequire(import.meta.url).resolve(`@fontsource/${pkg}/files/${name}`);
const face = (family, pkg, weight) =>
  `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(fontFile(pkg, `${pkg}-latin-${weight}-normal.woff2`)).toString("base64")}) format("woff2")}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${[400, 600, 700].map((w) => face("UI", "inter", w)).join("\n")}
${[400, 700].map((w) => face("Mono", "jetbrains-mono", w)).join("\n")}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#07070d;font-family:"UI",sans-serif;color:#eef0f6}
#bg{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 0%,#1a1436 0%,#0b0b17 55%,#06060b 100%)}
.blob{position:absolute;border-radius:50%;filter:blur(130px)}
.scene{position:absolute;inset:0;padding:110px 150px;display:flex;flex-direction:column}
.center{align-items:center;justify-content:center;text-align:center}
h1{font-size:104px;font-weight:700;letter-spacing:-.03em;line-height:1.05}
h2{font-size:72px;font-weight:700;letter-spacing:-.025em;line-height:1.08}
.sub{font-size:36px;color:#b9bdd0;margin-top:26px;line-height:1.35}
.kicker{font-size:22px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#d8ccff;margin-bottom:26px}
ul{list-style:none;margin-top:70px}
li{font-size:46px;line-height:1.3;margin-bottom:38px;padding-left:64px;position:relative}
li::before{content:"";position:absolute;left:0;top:18px;width:26px;height:26px;border-radius:8px;background:${accent}}
.panel{margin-top:60px;border-radius:20px;overflow:hidden;background:rgba(13,14,24,.86);border:1px solid rgba(255,255,255,.11);box-shadow:0 60px 120px -20px rgba(0,0,0,.75);flex:1;max-height:600px}
.bar{height:56px;display:flex;align-items:center;padding:0 24px;background:linear-gradient(#262738,#1c1d2b);gap:11px}
.bar i{width:16px;height:16px;border-radius:50%}
.body{padding:32px 42px;font-family:"Mono",monospace;font-size:31px;line-height:54px;white-space:pre-wrap}
.p{color:#f472b6;font-weight:700}.c{color:#c4b5fd;font-weight:700}.f{color:#fcd34d}.s{color:#86efac}.o{color:#9aa1b5}.k{color:#7dd3fc}
.cur{display:inline-block;width:17px;height:36px;background:#eef0f6;vertical-align:-6px;border-radius:2px}
#wave{position:absolute;left:0;right:0;bottom:44px;display:flex;justify-content:center;align-items:center;gap:6px;height:44px}
#wave i{width:6px;border-radius:3px;background:rgba(255,255,255,.8)}
#foot{position:absolute;right:60px;bottom:48px;font-family:"Mono";font-size:22px;color:rgba(200,204,222,.45)}
</style></head><body>
<div id="backdrop"><div id="bg"></div>
<div class="blob" style="width:760px;height:760px;background:${accent};opacity:.5;left:-140px;top:-220px"></div>
<div class="blob" style="width:680px;height:680px;background:#db2777;opacity:.32;right:-160px;top:140px"></div>
<div class="blob" style="width:820px;height:820px;background:#0ea5e9;opacity:.28;left:520px;bottom:-540px"></div></div>
<div id="fg"><div id="stage"></div><div id="wave"></div><div id="foot"></div></div>
<script>
const S = ${JSON.stringify(scenes.map(({ wav, ...s }) => s))}, LEAD = ${LEAD}, FADE = ${FADE}, CPS = ${CPS}, NB = 36;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const ease = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
// Colour a shell command: first word, -flags, "strings".
const shell = (s) => esc(s).replace(/("[^"]*"?|'[^']*'?)|(^|\\s)(-{1,2}[\\w-]+)|^(\\S+)/g, (m, str, sp, flag, first) =>
  str ? '<span class="s">' + str + '</span>' : flag ? sp + '<span class="f">' + flag + '</span>' : '<span class="c">' + first + '</span>');
const code = (s) => esc(s).replace(/(\\/\\/[^\\n]*|#[^\\n]*)|("[^"\\n]*"|'[^'\\n]*'|\`[^\`]*\`)|\\b(import|from|export|const|let|await|async|function|return|for|of|if|else|new|def|class)\\b/g,
  (m, com, str, kw) => com ? '<span class="o">' + com + '</span>' : str ? '<span class="s">' + str + '</span>' : '<span class="k">' + kw + '</span>');
const stage = document.getElementById("stage"), wave = document.getElementById("wave");
for (let i = 0; i < NB; i++) wave.appendChild(document.createElement("i"));
document.getElementById("foot").textContent = ${JSON.stringify(spec.footer ?? "")};
const els = S.map((s) => { const d = document.createElement("div"); d.className = "scene" + (s.type === "title" || s.type === "end" ? " center" : ""); stage.appendChild(d); return d; });
const head = (s) => (s.kicker ? '<div class="kicker">' + esc(s.kicker) + '</div>' : "") + '<h2>' + esc(s.title ?? "") + '</h2>' + (s.subtitle ? '<div class="sub">' + esc(s.subtitle) + '</div>' : "");
const bar = '<div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>';
window.setTime = (t) => {
  let sig = "";
  S.forEach((s, i) => {
    const el = els[i], lt = t - s.start;
    let a = Math.min(i === 0 ? 1 : ease(lt / FADE), i === S.length - 1 ? 1 : ease((s.end - t) / FADE));
    if (t < s.start || t >= s.end) a = 0;
    el.style.opacity = a; el.style.display = a > 0 ? "flex" : "none";
    if (a <= 0) return;
    let inner = "";
    if (s.type === "title" || s.type === "end") {
      inner = (s.kicker ? '<div class="kicker">' + esc(s.kicker) + '</div>' : "") + '<h1>' + esc(s.title ?? "") + '</h1>' + (s.subtitle ? '<div class="sub">' + esc(s.subtitle) + '</div>' : "");
    } else if (s.type === "points") {
      const n = (s.points ?? []).length, span = Math.max(s.dur, 1.5);
      inner = head(s) + "<ul>" + (s.points ?? []).map((p, k) => {
        const o = ease((lt - (LEAD + (span * k) / n)) / 0.35);
        return '<li style="opacity:' + o.toFixed(2) + ';transform:translateY(' + ((1 - o) * 16).toFixed(1) + 'px)">' + esc(p) + '</li>';
      }).join("") + "</ul>";
    } else if (s.type === "terminal") {
      const rows = []; let cursorOn = -1;
      for (const l of s.lines) {
        if (lt < l.at) break;
        if (l.cmd !== undefined) {
          const n = Math.min(l.cmd.length, Math.floor((lt - l.at) * CPS));
          rows.push('<span class="p">$</span> ' + shell(l.cmd.slice(0, n))); cursorOn = rows.length - 1;
        } else { rows.push('<span class="o">' + esc(l.out) + '</span>'); cursorOn = -1; }
      }
      const blink = Math.floor(lt * 2) % 2 === 0;
      inner = head(s) + '<div class="panel">' + bar + '<div class="body">' + rows.map((r, k) => r + (k === cursorOn && blink ? '<span class="cur"></span>' : "")).join("\\n") + '</div></div>';
    } else if (s.type === "code") {
      inner = head(s) + '<div class="panel">' + bar + '<div class="body">' + code(s.code ?? "") + '</div></div>';
    }
    if (el.dataset.h !== inner) { el.innerHTML = inner; el.dataset.h = inner; }
    sig += i + ":" + a.toFixed(3) + ":" + inner.length + ":" + (s.type === "points" ? inner.match(/opacity:[\\d.]+/g) : "") + (s.type === "terminal" ? Math.floor(lt * 2) : "") + "|";
    // Voice indicator, updated 10 times per second so that still frames can be reused.
    const k = Math.floor((lt - LEAD) * 10), on = k >= 0 && k < s.env.length;
    [...wave.children].forEach((b, j) => { const v = on ? s.env[Math.max(0, k - (NB - 1 - j))] ?? 0 : 0; b.style.height = (4 + v * 40) + "px"; b.style.opacity = on ? 0.35 + 0.65 * v : 0; });
    sig += on ? k : "-";
  });
  return sig;
};
</script></body></html>`;

// ---------- 3. frames ----------
let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright")); } // Claude's cloud workspace
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html);
await page.evaluate(() => Promise.all(['400 31px "Mono"', '700 31px "Mono"', '400 40px "UI"', '600 40px "UI"', '700 40px "UI"'].map((f) => document.fonts.load(f))));
// Bake the blurred backdrop into one image: blur on every frame is slow.
await page.evaluate(() => { document.getElementById("fg").style.display = "none"; });
const backdrop = (await page.screenshot({ type: "png" })).toString("base64");
await page.evaluate((b) => { document.getElementById("backdrop").remove(); document.body.style.background = `url(data:image/png;base64,${b}) 0 0/100% 100%`; document.getElementById("fg").style.display = ""; }, backdrop);

if (STILLS) {
  const dir = join(work, "stills"); mkdirSync(dir, { recursive: true });
  for (const [i, s] of scenes.entries()) {
    await page.evaluate((x) => window.setTime(x), s.end - TAIL - 0.05);
    await page.screenshot({ path: join(dir, `scene-${i + 1}.png`) });
  }
  console.log(`stills in ${dir} | planned length ${TOTAL.toFixed(1)}s`);
  await browser.close();
  process.exit(0);
}

const silent = join(work, "silent.mp4");
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", silent], { stdio: ["pipe", "inherit", "inherit"] });
const frames = Math.ceil(TOTAL * FPS);
let last = "", jpg, shots = 0;
for (let f = 0; f < frames; f++) {
  const sig = await page.evaluate((x) => window.setTime(x), f / FPS);
  if (sig !== last) { jpg = await page.screenshot({ type: "jpeg", quality: 96 }); last = sig; shots++; } // unchanged frame: reuse
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % 300 === 0) console.log(`frame ${f}/${frames}`);
}
ff.stdin.end();
await new Promise((r) => ff.once("close", r));
await browser.close();

// ---------- 4. sound: every clip at its scene time, then join ----------
const voiced = scenes.filter((s) => s.wav);
if (voiced.length === 0) { copyFileSync(silent, outFile); console.log(`done: ${outFile} (no narration)`); process.exit(0); }
const args = ["-y", "-loglevel", "error", "-i", silent];
voiced.forEach((s) => args.push("-i", s.wav));
const parts = voiced.map((s, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round((s.start + LEAD) * 1000)}:all=1[a${i}]`);
const mix = `${parts.join(";")};${voiced.map((_, i) => `[a${i}]`).join("")}amix=inputs=${voiced.length}:normalize=0,volume=1.6,alimiter=limit=0.95,apad,atrim=0:${TOTAL.toFixed(3)},aformat=channel_layouts=stereo[a]`;
execFileSync("ffmpeg", [...args, "-filter_complex", mix, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outFile], { stdio: "inherit" });
console.log(`done: ${outFile}  ${TOTAL.toFixed(1)}s, ${frames} frames (${shots} drawn)`);
