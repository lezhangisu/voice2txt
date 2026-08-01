# Voice2Txt — Real-time Speech-to-Text

> 中文版：[README.zh-CN.md](README.zh-CN.md)

An all-in-one web app for real-time speech recognition, audio file transcription, and AI-powered text structuring & summarization.
Pure frontend + a zero-dependency Node server. All third-party credentials stay server-side; a built-in access-key gate protects the app.

## Features

- **Real-time speech recognition** (Mandarin Chinese, switchable engines)
  - iFlytek IAT (streaming): true WebSocket streaming, word-by-word output, with pause-aware session rotation and a watchdog that rescues stalled sessions
  - Groq `whisper-large-v3`: chunked pseudo-streaming (silence-based segmentation), sentence-level output
  - English / Traditional Chinese: free in-browser Web Speech API
- **Audio file transcription** (switchable engines): uploads up to 100 MB (128 MB hard cap); iFlytek LFASR uploads directly, files >25 MB on the Groq engine are auto-compressed server-side via ffmpeg (16 kHz mono AAC); supports mp3 / wav / m4a / aac / flac / ogg
- **AI structuring & summarization** (switchable engines): DeepSeek (`deepseek-v4-flash`) or Groq-hosted free models (`qwen/qwen3.6-27b`) — one-click paragraph structuring or outline summary; on the Groq engine, long texts (5000+ English words / 6000+ CJK chars) automatically fall over to DeepSeek
- **Text tools**: merge into continuous text, multi-level undo ("Step Back"), automatic Traditional/Simplified Chinese detection & conversion (OpenCC data)
- **Export**: TXT / Markdown / Word (.doc — Markdown headings and nested lists are converted to native Word styles)
- **UI**: one-click Chinese/English switch (Chinese by default), access-key login (HttpOnly cookie, 30 days)
- **Usage protection**: per-user 60% rate limit for Groq free tier (calibrated from official response headers), circuit breaker for abnormal iFlytek session churn

## Architecture

```
Browser (pure static frontend)
  ├─ Microphone PCM ──► iFlytek WebSocket (signed URL issued by server; audio never touches the server)
  ├─ Microphone / files ──► server ──► Groq / iFlytek LFASR / DeepSeek (credentials never leave the server)
  └─ Traditional/Simplified conversion, Markdown parsing, text export: all done locally

server.js (zero-dependency, Node ≥18)
  ├─ Static-file whitelist (app files require auth; credential files always 404)
  ├─ Access-key gate (login throttling, HttpOnly cookie, automatic Secure flag behind HTTPS)
  └─ Authenticated proxies: /api/iflytek-sign  /api/llm  /api/transcribe*
```

## Quick Start

Requirements: Node.js ≥ 18 (no npm dependencies), latest Chrome / Edge / Safari.

```bash
# 1. Create configs (fill in your own credentials — see inline comments)
cp config.example.json config.json
cp keys.config.example.json keys.config.json

# 2. Run
node server.js        # defaults to http://127.0.0.1:5000 (override with PORT/HOST)

# 3. Open http://localhost:5000 and sign in with an access key
```

### Where to get credentials

| Credential | Used for | Where |
| --- | --- | --- |
| `appId` / `apiKey` / `apiSecret` | Real-time mic recognition (iFlytek) | [xfyun.cn](https://www.xfyun.cn) → 语音听写（流式版） |
| `lfasrSecret` | File transcription (iFlytek) | xfyun.cn → 录音文件转写 |
| `groqApiKey` | File transcription / AI (Groq) | [console.groq.com](https://console.groq.com) |
| `deepseekApiKey` | AI (DeepSeek) | [platform.deepseek.com](https://platform.deepseek.com) |
| `emailNotifyTo` / `smtpUser` / `smtpPass` | Access-request email notification | Gmail → 2-Step Verification → [App Password](https://myaccount.google.com/apppasswords) |

Everything lives in a single `config.json` with inline Chinese comments explaining every field.
**Config changes take effect immediately without restart**; only adding frontend files or editing `server.js` requires a restart.

## Deploying to Production

1. `server.js` binds to `127.0.0.1` by default — never expose that port directly;
2. Terminate HTTPS with Caddy / nginx as a reverse proxy (microphone access requires a secure context; the cookie automatically gets the `Secure` flag behind HTTPS);
3. Open only ports 80/443 in the firewall;
4. Distribute access keys privately; revoke by deleting the key from `keys.config.json` (effective immediately);
5. Install ffmpeg on the server (`sudo apt install ffmpeg`) — files >25 MB are transcoded before Groq;
6. Raise the proxy upload limit, e.g. nginx `client_max_body_size 130m;` (the 1 MB default rejects uploads with 413). Note Cloudflare's free plan caps uploads at 100 MB regardless.

## Project Structure

```
├── index.html / login.html   # App page / login page
├── request.html / request.js # Access-request page
├── style.css                 # Global styles
├── app.js                    # Frontend core (engine dispatch, organize/undo/export, LLM calls)
├── iflytek-asr.js            # iFlytek IAT true-streaming engine
├── groq-asr.js               # Groq chunked pseudo-streaming engine
├── pcm-worklet.js            # Audio capture AudioWorklet
├── zh-convert.js / -data.js  # Traditional/Simplified conversion (data from OpenCC, Apache-2.0)
├── i18n.js                   # UI language switch (Chinese/English)
├── login.js                  # Login page logic
├── server.js                 # Zero-dependency Node server (gate / signing / proxy / whitelist)
├── config.example.json       # Unified config template (copy to config.json)
├── keys.config.example.json  # Access-key pool template (copy to keys.config.json)
└── LICENSE                   # MIT
```

## License

MIT © 2026 Le Zhang
