/**
 * Voice2Txt — 本地服务：静态白名单、访问密钥门禁、讯飞签名、LLM/转写代理
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// Voice2Txt 服务（零依赖，仅需 Node.js）：
//   1. 访问密钥门禁：POST /api/login 校验密钥并种下 HttpOnly Cookie（30 天），
//      带每 IP 失败限流；
//   2. 静态文件白名单：不在名单内的一律 404，应用文件要求登录态——
//      杜绝路径穿越、大小写变体、隐藏文件（.git/凭据）泄露；
//   3. GET /api/iflytek-sign：讯飞听写 WebSocket 签名（需登录）；
//   4. POST /api/llm：代理调用 DeepSeek / Groq LLM（需登录，API Key 不出服务器）。
//
// 部署：默认只监听 127.0.0.1，对外暴露交给 HTTPS 反向代理（Caddy/nginx）。
// 启动：node server.js   （PORT / HOST 环境变量可覆盖）
// 配置：config.json（统一配置）、keys.config.json（访问密钥池）

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const KEYS_PATH = path.join(ROOT, "keys.config.json");

const COOKIE_NAME = "v2t_key";
const COOKIE_MAX_AGE = 30 * 24 * 3600; // 30 天（需求：至少 7 天）
const LLM_MAX_TEXT_CHARS = 200000;
const LOGIN_MAX_FAILS = 10; // 每 IP 在窗口期内允许的最大登录失败次数
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

// 静态文件白名单：路径名 → 磁盘文件。白名单外一律 404，
// 不接受任何用户输入的路径，从根上消除文件泄露面。
const PUBLIC_FILES = new Map([
  ["/login.html", "login.html"],
  ["/login.js", "login.js"],
  ["/i18n.js", "i18n.js"],
  ["/style.css", "style.css"],
]);
const AUTHED_FILES = new Map([
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/iflytek-asr.js", "iflytek-asr.js"],
  ["/groq-asr.js", "groq-asr.js"],
  ["/pcm-worklet.js", "pcm-worklet.js"],
  ["/zh-convert.js", "zh-convert.js"],
  ["/zh-convert-data.js", "zh-convert-data.js"],
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// LLM 系统提示词（kind → prompt），由服务端持有
const LLM_PROMPTS = {
  organize: `你是语音识别转写文本的整理助手。用户会给你一段语音转写的连续文本（可能缺少标点分段、含口语冗余）。
要求：
1. 严格保持原文措辞和内容，不增删、不改写、不总结；
2. 按语义逻辑把文本切分为段落；
3. 在合适的位置添加章节小标题（Markdown 的 ## 标题）；
4. 使用与原文相同的语言；
5. 只输出整理后的文本本身，不要任何解释或前后缀。`,
  summarize: `你是语音识别转写文本的归纳助手。用户会给你一段语音转写的文本。
要求：
1. 提炼文本的主干观点和关键信息，去除口语冗余和重复；
2. 用 Markdown 组织：先一段两三句话的总述，再用多级列表给出要点提纲；
3. 忠实于原文，不添加原文没有的信息；
4. 使用与原文相同的语言；
5. 只输出摘要本身，不要任何解释或前后缀。`,
};

// ---------- 工具 ----------

function sendJson(res, code, obj, extraHeaders) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(obj));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// 读取二进制请求体（音频文件上传用），返回 Buffer
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveFile(res, fileName, noStore) {
  fs.readFile(path.join(ROOT, fileName), (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fileName)] || "application/octet-stream",
      ...(noStore ? { "Cache-Control": "no-store" } : {}),
    });
    res.end(data);
  });
}

// ---------- 密钥、登录态与限流 ----------

function loadKeys() {
  try {
    const cfg = JSON.parse(fs.readFileSync(KEYS_PATH, "utf-8"));
    if (Array.isArray(cfg.keys) && cfg.keys.length) return cfg.keys;
  } catch (_) {
    /* 配置缺失或格式错误 */
  }
  return [];
}

function isValidKey(key) {
  return typeof key === "string" && loadKeys().includes(key);
}

function cookieKey(req) {
  const header = req.headers.cookie || "";
  const m = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function isAuthed(req) {
  return isValidKey(cookieKey(req));
}

function isSecureReq(req) {
  if (req.socket.encrypted) return true;
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https";
}

function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

const loginFails = new Map(); // ip → 失败时间戳数组

function loginThrottled(ip) {
  const now = Date.now();
  const arr = (loginFails.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginFails.set(ip, arr);
  return arr.length >= LOGIN_MAX_FAILS;
}

function recordLoginFail(ip) {
  const arr = loginFails.get(ip) || [];
  arr.push(Date.now());
  loginFails.set(ip, arr);
}

// ---------- 讯飞签名 ----------

// ---------- 统一配置（config.json） ----------

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    // 粘贴凭据时常带入空格/换行，统一 trim 避免签名错误
    for (const k of Object.keys(cfg)) {
      if (k !== "_说明" && typeof cfg[k] === "string") cfg[k] = cfg[k].trim();
    }
    return cfg;
  } catch (_) {
    /* 配置缺失或格式错误 */
  }
  return null;
}

// 讯飞 WebAPI 鉴权签名（与官方 demo 算法一致）
function buildSignedUrl(cfg) {
  const host = "iat-api.xfyun.cn";
  const reqPath = "/v2/iat";
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${reqPath} HTTP/1.1`;
  const signature = crypto
    .createHmac("sha256", cfg.apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin =
    `api_key="${cfg.apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString("base64");
  return (
    `wss://${host}${reqPath}?authorization=${encodeURIComponent(authorization)}` +
    `&date=${encodeURIComponent(date)}&host=${host}`
  );
}

// ---------- 讯飞录音文件转写（LFASR，文件上传转写） ----------

const LFASR_HOST = "https://raasr.xfyun.cn/v2/api";
const TRANSCRIBE_MAX_BYTES = 512 * 1024 * 1024; // 讯飞上限 500MB 量级

// LFASR 签名：signa = base64( HMAC-SHA1(SecretKey, hexMD5(appId + ts)) )
function lfasrSigna(appId, secretKey, ts) {
  const md5 = crypto.createHash("md5").update(appId + ts, "utf-8").digest("hex");
  return crypto.createHmac("sha1", secretKey).update(md5, "utf-8").digest("base64");
}

// 从转写结果 JSON 中按语句抽取文本（容错式遍历 rt/ws/cw/w 结构）
function extractSentences(orderResultObj) {
  const sentences = [];
  const collectWords = (node, out) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n) => collectWords(n, out));
      return;
    }
    if (typeof node.w === "string") {
      out.push(node.w);
      return;
    }
    for (const k of Object.keys(node)) collectWords(node[k], out);
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (Array.isArray(node.rt)) {
      for (const rt of node.rt) {
        const words = [];
        collectWords(rt, words);
        const s = words.join("").trim();
        if (s) sentences.push(s);
      }
      return;
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(orderResultObj);
  return sentences;
}

// ---------- Groq 文件转写（OpenAI 兼容 audio/transcriptions，同步返回） ----------

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MAX_BYTES = 25 * 1024 * 1024; // Groq 单文件上限 25MB

async function handleGroqTranscribe(req, res, url, cfg) {
  if (!cfg || !cfg.groqApiKey) {
    return sendJson(res, 501, {
      error: "未配置 Groq API Key（config.json 的 groqApiKey）",
    });
  }
  let body;
  try {
    body = await readRawBody(req, GROQ_MAX_BYTES + 4096); // 留余量以给出明确提示
  } catch (_) {
    return sendJson(res, 413, { error: "文件过大" });
  }
  if (!body.length) return sendJson(res, 400, { error: "空文件" });
  if (body.length > GROQ_MAX_BYTES) {
    return sendJson(res, 413, {
      error: "文件超过 Groq 25MB 上限，请压缩音频或改用讯飞引擎",
    });
  }

  const fileName = (url.searchParams.get("fileName") || "audio").slice(0, 200);
  const language = url.searchParams.get("language") === "en" ? "en" : "zh";

  const form = new FormData();
  form.append("file", new Blob([body]), fileName);
  form.append("model", cfg.groqModel || "whisper-large-v3");
  form.append("response_format", "verbose_json");
  form.append("language", language);

  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.groqApiKey}` },
      body: form,
    });
  } catch (err) {
    return sendJson(res, 502, { error: `Groq 请求失败：${err.message}` });
  }
  const rawText = await resp.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!resp.ok || !data) {
    console.log(
      `[voice2txt] Groq 转写异常: HTTP ${resp.status} body=${rawText.slice(0, 500)}`
    );
    const detail =
      (data && data.error && data.error.message) || rawText.slice(0, 200).trim();
    return sendJson(res, 502, {
      error: `Groq 转写失败：${detail || `HTTP ${resp.status}`}`,
    });
  }

  let sentences = [];
  if (Array.isArray(data.segments) && data.segments.length) {
    sentences = data.segments.map((s) => (s.text || "").trim()).filter(Boolean);
  }
  if (!sentences.length && typeof data.text === "string" && data.text.trim()) {
    sentences = [data.text.trim()];
  }
  return sendJson(res, 200, { done: true, sentences });
}

// ---------- Groq 实时语音块转写（伪流式：前端静音切块后逐块上传） ----------

// 单用户限速（与 LLM 相同的 60% 策略，独立计数；whisper 免费额度默认 20 次/分钟）
const GROQ_ASR_USAGE_RATIO = 0.6;
const GROQ_ASR_DEFAULT_LIMIT = 20;
let groqAsrLimit = GROQ_ASR_DEFAULT_LIMIT;
const groqAsrUsage = new Map(); // 用户标识 → { minute, requests }

const CHUNK_MAX_BYTES = 2 * 1024 * 1024; // 切块 ≤15s @16kHz16bit ≈ 480KB

// POST /api/transcribe-chunk?language=zh|en（body 为 WAV 字节）
async function handleTranscribeChunk(req, res, url) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: "unauthorized" });
  const cfg = loadConfig();
  if (!cfg || !cfg.groqApiKey) {
    return sendJson(res, 501, {
      error: "未配置 Groq API Key（config.json 的 groqApiKey）",
    });
  }

  // 单用户限速：超过 Groq 免费请求额度 60% 即要求客户端稍后重试
  const user = cookieKey(req) || clientIp(req);
  const minute = Math.floor(Date.now() / 60000);
  let usage = groqAsrUsage.get(user);
  if (!usage || usage.minute !== minute) {
    usage = { minute, requests: 0 };
    groqAsrUsage.set(user, usage);
  }
  const reqCap = Math.max(1, Math.floor(groqAsrLimit * GROQ_ASR_USAGE_RATIO));
  if (usage.requests >= reqCap) {
    return sendJson(res, 429, {
      error: "rate_limited",
      message: `已达 Groq 语音识别限速的 ${GROQ_ASR_USAGE_RATIO * 100}%（${reqCap} 次/分钟），稍后自动继续`,
    });
  }
  usage.requests += 1;

  let body;
  try {
    body = await readRawBody(req, CHUNK_MAX_BYTES);
  } catch (_) {
    return sendJson(res, 413, { error: "语音块过大" });
  }
  if (!body.length) return sendJson(res, 400, { error: "空语音块" });

  const language = url.searchParams.get("language") === "en" ? "en" : "zh";
  const form = new FormData();
  form.append("file", new Blob([body], { type: "audio/wav" }), "chunk.wav");
  form.append("model", cfg.groqModel || "whisper-large-v3");
  form.append("response_format", "json");
  form.append("language", language);

  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.groqApiKey}` },
      body: form,
    });
  } catch (err) {
    return sendJson(res, 502, { error: `Groq 请求失败：${err.message}` });
  }

  // 按官方响应头校准限速上限
  const limReq = Number(resp.headers.get("x-ratelimit-limit-requests"));
  if (limReq > 0) groqAsrLimit = limReq;

  const rawText = await resp.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!resp.ok || !data) {
    console.log(
      `[voice2txt] Groq 语音块异常: HTTP ${resp.status} body=${rawText.slice(0, 500)}`
    );
    const detail =
      (data && data.error && data.error.message) || rawText.slice(0, 200).trim();
    return sendJson(res, 502, {
      error: `Groq 识别失败：${detail || `HTTP ${resp.status}`}`,
    });
  }
  return sendJson(res, 200, { text: (data.text || "").trim() });
}

// POST /api/transcribe?fileName=..&duration=..&language=cn|en（body 为音频原始字节）
async function handleTranscribe(req, res, url) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: "unauthorized" });
  const cfg = loadConfig();
  const engine = ((cfg && cfg.transcribeEngine) || "iflytek").toLowerCase();
  if (engine === "groq") {
    return handleGroqTranscribe(req, res, url, cfg);
  }
  if (!cfg || !cfg.lfasrSecret) {
    return sendJson(res, 501, {
      error:
        "未配置录音文件转写凭据（config.json 的 lfasrSecret），" +
        "或将 transcribeEngine 切换为 groq",
    });
  }

  let body;
  try {
    body = await readRawBody(req, TRANSCRIBE_MAX_BYTES);
  } catch (_) {
    return sendJson(res, 413, { error: "文件过大" });
  }
  if (!body.length) return sendJson(res, 400, { error: "空文件" });

  const fileName = (url.searchParams.get("fileName") || "audio").slice(0, 200);
  const language = url.searchParams.get("language") === "en" ? "en" : "cn";
  const duration = String(parseInt(url.searchParams.get("duration"), 10) || 0);
  const ts = String(Math.floor(Date.now() / 1000));

  const params = new URLSearchParams({
    appId: cfg.appId,
    signa: lfasrSigna(cfg.appId, cfg.lfasrSecret, ts),
    ts,
    fileSize: String(body.length),
    fileName,
    duration,
    language,
  });

  let resp;
  try {
    resp = await fetch(`${LFASR_HOST}/upload?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    return sendJson(res, 502, { error: `讯飞上传请求失败：${err.message}` });
  }
  // 先读原始文本再尝试解析 JSON：讯飞出错时可能返回不同结构，
  // 把原始响应体记录到服务端日志并回显摘要，便于定位
  const rawText = await resp.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!data || data.code !== "000000") {
    console.log(
      `[voice2txt] 讯飞上传异常: HTTP ${resp.status} body=${rawText.slice(0, 500)}`
    );
    const detail =
      (data && (data.message || data.descInfo || data.failed)) ||
      rawText.slice(0, 200).trim();
    return sendJson(res, 502, {
      error: `讯飞上传失败：${detail || `HTTP ${resp.status}`}`,
    });
  }
  return sendJson(res, 200, { orderId: data.content.orderId });
}

// GET /api/transcribe-result?orderId=..
async function handleTranscribeResult(req, res, url) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: "unauthorized" });
  const cfg = loadConfig();
  if (!cfg || !cfg.lfasrSecret) {
    return sendJson(res, 501, {
      error: "未配置录音文件转写凭据（config.json 的 lfasrSecret）",
    });
  }
  const orderId = (url.searchParams.get("orderId") || "").slice(0, 100);
  if (!orderId) return sendJson(res, 400, { error: "缺少 orderId" });

  const ts = String(Math.floor(Date.now() / 1000));
  const params = new URLSearchParams({
    appId: cfg.appId,
    signa: lfasrSigna(cfg.appId, cfg.lfasrSecret, ts),
    ts,
    orderId,
    resultType: "transfer", // 仅转写；predict（质检）需单独开通，未开通会导致 failType=11
  });

  let resp;
  try {
    resp = await fetch(`${LFASR_HOST}/getResult?${params}`, { method: "POST" });
  } catch (err) {
    return sendJson(res, 502, { error: `讯飞查询请求失败：${err.message}` });
  }
  const rawText = await resp.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!data || data.code !== "000000") {
    console.log(
      `[voice2txt] 讯飞查询异常: HTTP ${resp.status} body=${rawText.slice(0, 500)}`
    );
    const detail =
      (data && (data.message || data.descInfo || data.failed)) ||
      rawText.slice(0, 200).trim();
    return sendJson(res, 502, {
      error: `讯飞查询失败：${detail || `HTTP ${resp.status}`}`,
    });
  }

  const info = (data.content && data.content.orderInfo) || {};
  if (info.status === 3) return sendJson(res, 200, { state: "processing" });
  if (info.status === 4) {
    let sentences = [];
    try {
      sentences = extractSentences(JSON.parse(data.content.orderResult));
    } catch (_) {
      /* 解析失败时返回空，前端提示 */
    }
    return sendJson(res, 200, { state: "done", sentences });
  }
  return sendJson(res, 200, {
    state: "failed",
    error: `转写失败（status=${info.status} failType=${info.failType}）`,
  });
}

// ---------- DeepSeek / Groq LLM 代理 ----------

// ---------- Groq LLM（免费模型，单用户限速：官方额度的 60%） ----------

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_USAGE_RATIO = 0.6; // 单用户使用量上限 = Groq 免费额度 × 60%
// 限速值先用保守默认，每次调用后按 Groq 响应头动态校准
const GROQ_DEFAULT_LIMITS = { requests: 30, tokens: 6000 };
let groqLimits = { ...GROQ_DEFAULT_LIMITS };
const groqUsage = new Map(); // 用户标识 → { minute, requests, tokens }

async function handleGroqLlm(req, res, cfg, systemPrompt, text) {
  const groqKey = cfg && cfg.groqApiKey;
  if (!groqKey) {
    return sendJson(res, 501, {
      error: "未配置 Groq API Key（config.json 的 groqApiKey）",
    });
  }

  // 单用户限速检查（按访问密钥 Cookie 区分用户）
  const user = cookieKey(req) || clientIp(req);
  const minute = Math.floor(Date.now() / 60000);
  let usage = groqUsage.get(user);
  if (!usage || usage.minute !== minute) {
    usage = { minute, requests: 0, tokens: 0 };
    groqUsage.set(user, usage);
  }
  const reqCap = Math.max(1, Math.floor(groqLimits.requests * GROQ_USAGE_RATIO));
  const tokCap = Math.max(100, Math.floor(groqLimits.tokens * GROQ_USAGE_RATIO));
  if (usage.requests >= reqCap || usage.tokens >= tokCap) {
    return sendJson(res, 429, {
      error: "rate_limited",
      message:
        `你本分钟的使用量已达到 Groq 免费额度的 ${GROQ_USAGE_RATIO * 100}%` +
        `（上限：${reqCap} 次调用 或 ${tokCap} tokens / 分钟），请休息一会儿再继续`,
    });
  }
  usage.requests += 1;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100000);
  let resp;
  try {
    resp = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: cfg.groqLlmModel || "qwen/qwen3.6-27b",
        reasoning_effort: "none", // Qwen3 思考内容不计入回复，也避免消耗 token 额度
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        stream: false,
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    return sendJson(res, 502, {
      error:
        err.name === "AbortError"
          ? "Groq 请求超时"
          : `Groq 请求失败：${err.message}`,
    });
  }
  clearTimeout(timeout);

  // 按 Groq 官方响应头校准限速上限
  const limReq = Number(resp.headers.get("x-ratelimit-limit-requests"));
  const limTok = Number(resp.headers.get("x-ratelimit-limit-tokens"));
  if (limReq > 0) groqLimits.requests = limReq;
  if (limTok > 0) groqLimits.tokens = limTok;

  const rawText = await resp.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!resp.ok || !data) {
    console.log(
      `[voice2txt] Groq LLM 异常: HTTP ${resp.status} body=${rawText.slice(0, 500)}`
    );
    const detail =
      (data && data.error && data.error.message) || rawText.slice(0, 200).trim();
    return sendJson(res, 502, {
      error: `Groq LLM 调用失败：${detail || `HTTP ${resp.status}`}`,
    });
  }

  // 统计真实 token 用量（无 usage 字段时按字符数粗估）
  const used = data.usage && Number(data.usage.total_tokens);
  usage.tokens += Number.isFinite(used)
    ? used
    : Math.ceil((systemPrompt.length + text.length) / 4);

  const content =
    data.choices && data.choices[0] && data.choices[0].message.content;
  // 兜底剥离 <think> 思考块（部分模型即使关闭推理也可能输出）
  const cleaned = (content || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim();
  return sendJson(res, 200, { content: cleaned });
}

async function handleLlm(req, res) {
  if (!isAuthed(req)) return sendJson(res, 401, { error: "unauthorized" });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (_) {
    return sendJson(res, 400, { error: "请求格式错误" });
  }
  const { kind, text } = body || {};
  const systemPrompt = LLM_PROMPTS[kind];
  if (!systemPrompt || typeof text !== "string" || !text.trim()) {
    return sendJson(res, 400, { error: "参数错误" });
  }
  if (text.length > LLM_MAX_TEXT_CHARS) {
    return sendJson(res, 413, { error: "文本过长" });
  }

  const cfg = loadConfig();
  const engine = ((cfg && cfg.llmEngine) || "deepseek").toLowerCase();
  if (engine === "groq") {
    return await handleGroqLlm(req, res, cfg, systemPrompt, text);
  }
  const dsKey = cfg && cfg.deepseekApiKey;
  if (!dsKey) {
    return sendJson(res, 501, {
      error: "服务端未配置 DeepSeek API Key（config.json 的 deepseekApiKey）",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100000);
  let resp;
  try {
    resp = await fetch(
      `${cfg.deepseekBaseUrl || "https://api.deepseek.com"}/chat/completions`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${dsKey}`,
        },
        body: JSON.stringify({
          model: cfg.deepseekModel || "deepseek-v4-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          stream: false,
        }),
      }
    );
  } catch (err) {
    clearTimeout(timeout);
    return sendJson(res, 502, {
      error:
        err.name === "AbortError"
          ? "DeepSeek 请求超时"
          : `DeepSeek 请求失败：${err.message}`,
    });
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    return sendJson(res, 502, {
      error: `DeepSeek 返回 ${resp.status}：${t.slice(0, 200)}`,
    });
  }
  const data = await resp.json();
  const content =
    data.choices && data.choices[0] && data.choices[0].message.content;
  sendJson(res, 200, { content: (content || "").trim() });
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const authed = isAuthed(req);

  try {
    if (pathname === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (loginThrottled(ip)) {
        return sendJson(res, 429, { ok: false, error: "too_many_requests" });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (_) {
        return sendJson(res, 400, { ok: false });
      }
      if (body && isValidKey(body.key)) {
        loginFails.delete(ip);
        return sendJson(res, 200, { ok: true }, {
          "Set-Cookie":
            `${COOKIE_NAME}=${encodeURIComponent(body.key)}; ` +
            `Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Strict` +
            (isSecureReq(req) ? "; Secure" : ""),
        });
      }
      recordLoginFail(ip);
      return sendJson(res, 401, { ok: false });
    }

    if (pathname === "/api/session" && req.method === "GET") {
      return sendJson(res, 200, { ok: authed });
    }

    if (pathname === "/api/asr-status" && req.method === "GET") {
      if (!authed) return sendJson(res, 401, { error: "unauthorized" });
      const cfg = loadConfig();
      return sendJson(res, 200, {
        iflytek: !!(cfg && cfg.apiKey && cfg.apiSecret),
        groq: !!(cfg && cfg.groqApiKey),
        realtimeEngine: ((cfg && cfg.realtimeEngine) || "iflytek").toLowerCase(),
      });
    }

    if (pathname === "/api/iflytek-sign" && req.method === "GET") {
      if (!authed) return sendJson(res, 401, { error: "unauthorized" });
      const cfg = loadConfig();
      if (!cfg || !cfg.apiKey || !cfg.apiSecret) {
        return sendJson(res, 501, {
          error: "未配置 config.json（需要 appId / apiKey / apiSecret）",
        });
      }
      return sendJson(res, 200, { url: buildSignedUrl(cfg), appId: cfg.appId });
    }

    if (pathname === "/api/llm" && req.method === "POST") {
      return await handleLlm(req, res);
    }

    if (pathname === "/api/transcribe" && req.method === "POST") {
      return await handleTranscribe(req, res, url);
    }

    if (pathname === "/api/transcribe-result" && req.method === "GET") {
      return await handleTranscribeResult(req, res, url);
    }

    if (pathname === "/api/transcribe-chunk" && req.method === "POST") {
      return await handleTranscribeChunk(req, res, url);
    }
  } catch (err) {
    return sendJson(res, 500, { error: `服务端错误：${err.message}` });
  }

  // 静态文件（白名单制）
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  if (pathname === "/" || pathname === "") {
    if (authed) return serveFile(res, "index.html", true);
    return redirect(res, "/login.html");
  }

  if (pathname === "/login.html") {
    if (authed) return redirect(res, "/");
    return serveFile(res, "login.html", true);
  }

  if (PUBLIC_FILES.has(pathname)) {
    return serveFile(res, PUBLIC_FILES.get(pathname), false);
  }

  if (AUTHED_FILES.has(pathname)) {
    if (!authed) return sendJson(res, 401, { error: "unauthorized" });
    return serveFile(res, AUTHED_FILES.get(pathname), true);
  }

  // 白名单外一律 404（包括凭据文件、隐藏文件、路径穿越尝试）
  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`Voice2Txt 已启动: http://${HOST}:${PORT}`);
  console.log(`访问密钥：${loadKeys().length} 个（keys.config.json）`);
  const cfg = loadConfig() || {};
  console.log(
    cfg.apiKey && cfg.apiSecret
      ? "讯飞引擎：已配置"
      : "讯飞引擎：未配置（config.json），中文将回退浏览器引擎"
  );
  const llmEngine = (cfg.llmEngine || "deepseek").toLowerCase();
  console.log(
    llmEngine === "groq"
      ? `LLM 引擎：groq（${cfg.groqLlmModel || "qwen/qwen3.6-27b"}，单用户限速 60%）`
      : cfg.deepseekApiKey
        ? "LLM 引擎：deepseek（已配置）"
        : "LLM 引擎：deepseek（警告：未配置 deepseekApiKey）"
  );
  const engine = (cfg.transcribeEngine || "iflytek").toLowerCase();
  console.log(
    `文件转写引擎：${engine}` +
      (engine === "groq"
        ? cfg.groqApiKey
          ? "（Groq 已配置）"
          : "（警告：未配置 groqApiKey）"
        : cfg.lfasrSecret
          ? "（讯飞已配置）"
          : "（警告：未配置 lfasrSecret）")
  );
  const rtEngine = (cfg.realtimeEngine || "iflytek").toLowerCase();
  console.log(`实时识别引擎：${rtEngine}`);
});
