# Voice2Txt — 实时语音转文字

> English version: [README.md](README.md)

麦克风实时语音识别、音频文件转写、AI 整理与归纳的一站式网页工具。
纯前端 + 零依赖 Node 服务，所有第三方凭据只留在服务端，内置访问密钥门禁。

## 功能特性

- **实时语音识别**（中文普通话，双引擎可选）
  - 讯飞语音听写（流式版）：真流式 WebSocket，逐字流动出字，带停顿感知会话轮换、看门狗卡死抢救
  - Groq `whisper-large-v3`：静音切块伪流式，停顿后按句出字
  - English / 中文繁体：浏览器内置 Web Speech API（免费）
- **音频文件转写**（双引擎可选）：讯飞录音文件转写（500MB / 5 小时）或 Groq（更快，25MB 以内），支持 mp3 / wav / m4a / aac / flac / ogg
- **AI 整理与归纳**（双引擎可选）：DeepSeek（`deepseek-v4-flash`）或 Groq 免费模型（`qwen/qwen3.6-27b`），一键整理分段 / 归纳摘要
- **文本工具**：整理为连续文本、回到上一步（多级撤销）、繁简自动检测与双向转换（OpenCC 字库）
- **导出**：TXT / Markdown / Word（.doc，自动把 Markdown 标题、多级列表转为 Word 原生样式）
- **界面**：中英文一键切换（默认中文）、访问密钥登录（HttpOnly Cookie 30 天）
- **用量保护**：Groq 免费额度单用户 60% 限速（按官方响应头动态校准），讯飞会话异常熔断

## 架构

```
浏览器（纯静态前端）
  ├─ 麦克风 PCM ──► 讯飞 WebSocket（签名 URL 由 server 签发，音频不经过 server）
  ├─ 麦克风/文件 ──► server ──► Groq / 讯飞 LFASR / DeepSeek（凭据不出 server）
  └─ 繁简转换、Markdown 解析、文本导出：全部本地完成

server.js（零依赖 Node ≥18）
  ├─ 静态文件白名单（应用文件需登录态，凭据文件一律 404）
  ├─ 访问密钥门禁（登录限流、HttpOnly Cookie、HTTPS 自动 Secure）
  └─ 接口鉴权代理：/api/iflytek-sign /api/llm /api/transcribe* 
```

## 快速开始

要求：Node.js ≥ 18（无 npm 依赖），浏览器 Chrome / Edge / Safari 最新版。

```bash
# 1. 创建配置（填入你自己的凭据，详见文件内注释）
cp config.example.json config.json
cp keys.config.example.json keys.config.json

# 2. 启动
node server.js        # 默认 http://127.0.0.1:5000，PORT/HOST 环境变量可覆盖

# 3. 浏览器打开 http://localhost:5000 ，输入访问密钥进入
```

### 凭据获取

| 凭据 | 用途 | 获取位置 |
| --- | --- | --- |
| `appId` / `apiKey` / `apiSecret` | 麦克风实时识别（讯飞引擎） | [讯飞开放平台](https://www.xfyun.cn) → 语音听写（流式版） |
| `lfasrSecret` | 文件转写（讯飞引擎） | 讯飞开放平台 → 录音文件转写 |
| `groqApiKey` | 文件转写 / AI 整理（Groq 引擎） | [console.groq.com](https://console.groq.com) |
| `deepseekApiKey` | AI 整理（DeepSeek 引擎） | [platform.deepseek.com](https://platform.deepseek.com) |
| `emailNotifyTo` / `smtpUser` / `smtpPass` | 密钥申请邮件通知 | Gmail → 两步验证 → [应用专用密码](https://myaccount.google.com/apppasswords) |

所有配置集中在 `config.json`（文件内自带逐行注释），**改完即生效，无需重启**；
但新增前端文件或修改 `server.js` 后需要重启进程。

## 部署到公网

1. `server.js` 默认只监听 `127.0.0.1`，不要直接对外暴露该端口；
2. 用 Caddy / nginx 做 HTTPS 反向代理（麦克风权限要求安全上下文，Cookie 在 HTTPS 下自动附加 `Secure`）；
3. 防火墙只开放 80/443；
4. 密钥私下分发，泄露即从 `keys.config.json` 删除（即时生效）。

## 文件结构

```
├── index.html / login.html   # 主页面 / 登录页
├── request.html / request.js # 申请访问页
├── style.css                 # 全局样式
├── app.js                    # 前端主逻辑（识别调度、整理/撤销/导出、LLM 调用）
├── iflytek-asr.js            # 讯飞听写（流式版）真流式引擎
├── groq-asr.js               # Groq 伪流式引擎（静音切块）
├── pcm-worklet.js            # 音频采集 AudioWorklet
├── zh-convert.js / -data.js  # 繁简转换（数据源自 OpenCC，Apache-2.0）
├── i18n.js                   # 界面中英文切换
├── login.js                  # 登录页逻辑
├── server.js                 # 零依赖 Node 服务（门禁 / 签名 / 代理 / 白名单）
├── config.example.json       # 统一配置范本（复制为 config.json 使用）
├── keys.config.example.json  # 访问密钥池范本（复制为 keys.config.json 使用）
└── LICENSE                   # MIT
```

## License

MIT © 2026 Le Zhang
