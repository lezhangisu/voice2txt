/**
 * Voice2Txt — 前端主逻辑：识别调度、文本整理/撤销/保存、LLM 与文件转写调用
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// Voice2Txt — 基于浏览器 Web Speech API 的实时语音转文字。
// 识别完全在浏览器端完成，服务器只提供静态文件，零计算开销、零 API 费用。

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const els = {
  warning: document.getElementById("support-warning"),
  langSelect: document.getElementById("lang-select"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  clearBtn: document.getElementById("clear-btn"),
  micStatus: document.getElementById("mic-status"),
  recStatus: document.getElementById("rec-status"),
  transcript: document.getElementById("transcript"),
  interim: document.getElementById("interim"),
  organized: document.getElementById("organized"),
  organizeBtn: document.getElementById("organize-btn"),
  llmOrganizeBtn: document.getElementById("llm-organize-btn"),
  llmSummarizeBtn: document.getElementById("llm-summarize-btn"),
  saveFormat: document.getElementById("save-format"),
  saveBtn: document.getElementById("save-btn"),
  undoBtn: document.getElementById("undo-btn"),
  audioFile: document.getElementById("audio-file"),
  transcribeBtn: document.getElementById("transcribe-btn"),
  transcribeStatus: document.getElementById("transcribe-status"),
  appMain: document.getElementById("app-main"),
};

let recognition = null;
let iflytekSession = null;
let groqSession = null;
let asrEngine = null; // 'webspeech' | 'iflytek' | 'groq'
let isRecording = false; // 用户意图：是否处于识别中
let micGranted = false;

// 自动重启 / 看门狗 / 会话轮换状态
let restartTimer = null;
let restartAttempts = 0;
let watchdogTimer = null;
let rotationTimer = null;
let rotatePending = false; // 已到轮换周期，等待说话间隙执行
let rotatePendingSince = 0; // 标记待轮换的时间，用于强制兜底
let lastProgressAt = 0; // 最近一次识别文本“实际变化”的时间
let lastSeenResultSig = ""; // 上一次 onresult 的内容签名，用于判断文本是否变化
let flushing = false; // 正在通过 stop() 强制结算当前语句

const WATCHDOG_INTERVAL_MS = 3000; // 看门狗检查频率
const WATCHDOG_IDLE_MS = 15000; // 识别文本超过该时长无变化则判定卡死
const ROTATE_INTERVAL_MS = 45000; // 会话轮换周期：到期后等待说话间隙结算
const ROTATE_FORCE_MS = 30000; // 待轮换超过该时长仍无停顿则强制执行
const INTERIM_FLUSH_CHARS = 400; // 单个 interim 超过该长度仍未落定则立即强制结算

// ---------- 调试日志 ----------
// 发布版本不提供调试面板，日志仅输出到浏览器控制台（F12 → Console）。

function dbg(msg) {
  console.log("[voice2txt]", msg);
}

// ---------- 界面状态 ----------

function setMicStatus(text, kind) {
  els.micStatus.textContent = `麦克风：${text}`;
  els.micStatus.className = `status-badge${kind ? " " + kind : ""}`;
}

function setRecStatus(text, kind) {
  els.recStatus.textContent = `状态：${text}`;
  els.recStatus.className = `status-badge${kind ? " " + kind : ""}`;
}

function setControls(recording) {
  els.startBtn.disabled = recording;
  els.stopBtn.disabled = !recording;
  els.langSelect.disabled = recording;
}

// ---------- 麦克风权限 ----------

async function requestMicPermission() {
  if (micGranted) return true;
  setMicStatus("正在请求权限…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // 仅需授权，立即释放
    micGranted = true;
    setMicStatus("已授权", "active");
    dbg("麦克风权限已获取");
    return true;
  } catch (err) {
    micGranted = false;
    setMicStatus(
      err && err.name === "NotAllowedError" ? "权限被拒绝" : "不可用",
      "error"
    );
    setRecStatus("请在浏览器地址栏允许麦克风后重试", "error");
    dbg(`麦克风权限失败: ${err && err.name} ${err && err.message}`);
    return false;
  }
}

// ---------- 识别结果显示 ----------

function appendFinal(text) {
  const placeholder = els.transcript.querySelector(".placeholder");
  if (placeholder) placeholder.remove();
  const p = document.createElement("p");
  p.textContent = text;
  els.transcript.appendChild(p);
  scrollToBottom();
}

function scrollToBottom() {
  const panel = els.transcript.parentElement;
  panel.scrollTop = panel.scrollHeight;
}

// ---------- 识别会话管理 ----------

// 核心背景：Chrome 的 continuous 模式下，说话人不停顿时所有内容会堆进
// 同一个永不 finalize 的 interim 结果；到达识别服务的单句内部上限后，
// 假设停止更新，但会话不报错也不触发 onend —— 表现为“卡在长句不动”。
// 对策 = 定时轮换（stop() 强制结算）+ 超长 interim 立即结算 + 内容进度看门狗。

function createRecognition() {
  const rec = new SpeechRecognition();
  rec.continuous = true; // 持续识别，不因停顿结束
  rec.interimResults = true; // 返回中间结果，实现“流动”实时显示
  rec.lang = els.langSelect.value; // 默认 en-US，可切换中文
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    lastProgressAt = Date.now();
    lastSeenResultSig = "";
    flushing = false;
    rotatePending = false;
    dbg(`识别会话已启动 (lang=${rec.lang})`);
  };

  rec.onresult = (event) => {
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text) continue;
      if (result.isFinal) {
        appendFinal(text);
        flushing = false;
        dbg(`final: "${text}"`);
      } else {
        interimText += text + " ";
      }
    }

    // 只在识别文本“实际变化”时刷新进度时间——
    // 卡死时 Chrome 可能重复派发内容不变的 result 事件，不能视为健康。
    const last = event.results[event.results.length - 1];
    const sig = `${event.results.length}|${last.isFinal}|${last[0].transcript}`;
    if (sig !== lastSeenResultSig) {
      lastSeenResultSig = sig;
      lastProgressAt = Date.now();
      restartAttempts = 0; // 有新内容说明会话健康，重置退避
    }

    els.interim.textContent = interimText;
    if (interimText) scrollToBottom();

    // 单句内部缓冲保护：interim 过长且迟迟不 finalize 时，
    // 主动 stop() 把它强制结算成 final，随后由 onend 无缝重启。
    if (!flushing && interimText.length > INTERIM_FLUSH_CHARS) {
      flushing = true;
      dbg(
        `interim 已达 ${interimText.length} 字符未落定，stop() 强制结算当前语句`
      );
      restartAttempts = 0;
      try {
        recognition.stop();
      } catch (err) {
        dbg(`强制结算失败: ${err.name} ${err.message}`);
      }
    }
  };

  rec.onspeechstart = () => dbg("检测到语音开始");
  rec.onspeechend = () => {
    dbg("检测到语音结束");
    // 到期待轮换时，趁说话人停顿的自然间隙轮换会话：
    // 停顿时重启的几十毫秒缺口没有任何语音，实现无缝衔接。
    if (rotatePending) performRotation("说话间隙");
  };
  rec.onaudiostart = () => dbg("音频捕获开始");
  rec.onaudioend = () => dbg("音频捕获结束");

  rec.onerror = (event) => {
    dbg(`识别错误: error=${event.error} message=${event.message || "(无)"}`);
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      isRecording = false;
      micGranted = false;
      stopWatchdog();
      stopRotation();
      setMicStatus("权限被拒绝", "error");
      setRecStatus("已停止（无麦克风权限）", "error");
      setControls(false);
    } else if (event.error === "audio-capture") {
      setRecStatus("未检测到麦克风设备，自动重试中…", "error");
      // 由 onend 走自动重启（带退避）
    } else if (event.error === "network") {
      setRecStatus("识别服务网络异常，自动重试中…", "error");
      // 由 onend 走自动重启（带退避）
    }
    // no-speech / aborted 属正常情况，静默等待 onend 处理
  };

  // Chrome 在静音超时、网络抖动、主动 stop() 或内部错误时会结束会话；
  // 只要用户没按停止，就带退避地自动重启以保持持续识别。
  rec.onend = () => {
    dbg("识别会话结束 (onend)");
    if (isRecording) {
      scheduleRestart();
    } else {
      stopWatchdog();
      stopRotation();
      setRecStatus("空闲");
      setControls(false);
    }
  };

  return rec;
}

// 健康轮换/强制结算前会把 restartAttempts 清零，此时 0ms 立即重启，
// 音频缺口只有几十毫秒；只有异常重试才走 250ms 起的指数退避（封顶 3s），
// 避免会话反复失败时陷入高频重启被服务限流。
function scheduleRestart() {
  clearTimeout(restartTimer);
  const delay =
    restartAttempts === 0
      ? 0
      : Math.min(250 * Math.pow(2, restartAttempts - 1), 3000);
  restartAttempts++;
  dbg(`${delay}ms 后自动重启识别（连续第 ${restartAttempts} 次）`);
  restartTimer = setTimeout(() => {
    if (!isRecording || !recognition) return;
    try {
      recognition.start();
    } catch (err) {
      // InvalidStateError（已在运行）等偶发异常，交给看门狗兜底
      dbg(`重启失败: ${err.name} ${err.message}`);
    }
  }, delay);
}

// 看门狗：监测“内容进度”而非事件有无。识别文本 15 秒无任何变化即判定
// 卡死；先把冻结的 interim 抢救为正文（避免丢字），再 abort 强制重建会话。
// 同时负责兜底执行超时的待轮换（说话人一直不停的情况）。
function startWatchdog() {
  stopWatchdog();
  lastProgressAt = Date.now();
  watchdogTimer = setInterval(() => {
    if (!isRecording || !recognition) return;

    // 待轮换超过 ROTATE_FORCE_MS 仍未等到说话间隙，强制执行，
    // 保证单句内部缓冲不会被长句撑满（此时重启缺口仅几十毫秒）。
    if (rotatePending && Date.now() - rotatePendingSince > ROTATE_FORCE_MS) {
      dbg(`说话人持续无停顿超过 ${ROTATE_FORCE_MS / 1000}s，强制执行轮换`);
      performRotation("强制");
      return;
    }

    const idleMs = Date.now() - lastProgressAt;
    if (idleMs > WATCHDOG_IDLE_MS) {
      const frozen = els.interim.textContent.trim();
      if (frozen) {
        appendFinal(frozen);
        els.interim.textContent = "";
        dbg(`看门狗：抢救未落定内容 "${frozen.slice(0, 60)}${frozen.length > 60 ? "…" : ""}"`);
      }
      dbg(`看门狗：${Math.round(idleMs / 1000)}s 无新内容，强制重启会话`);
      lastProgressAt = Date.now(); // 防止 abort→onend 间隙重复触发
      try {
        recognition.abort();
      } catch (err) {
        dbg(`看门狗 abort 失败: ${err.name} ${err.message}`);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

// 执行一次会话轮换：stop() 会把当前积压的 interim 结算为 final 后结束，
// 随后由 onend 以 0ms 延迟立即重启。在说话间隙执行时无任何语音损失。
function performRotation(reason) {
  if (!isRecording || !recognition || flushing) return;
  rotatePending = false;
  dbg(`会话轮换（${reason}）：stop() 结算当前语句`);
  restartAttempts = 0; // 健康轮换，0ms 立即重启
  try {
    recognition.stop();
  } catch (err) {
    dbg(`会话轮换失败: ${err.name} ${err.message}`);
  }
}

// 会话轮换调度：每 45s 标记一次“到期待轮换”，优先等 onspeechend 的
// 说话间隙再 stop() 结算（无缝）；若说话人一直不停，由看门狗在
// ROTATE_FORCE_MS 后强制执行，或 interim 超 400 字符时立即强制结算。
function startRotation() {
  stopRotation();
  rotatePending = false;
  rotationTimer = setInterval(() => {
    if (!isRecording || !recognition || flushing || rotatePending) return;
    rotatePending = true;
    rotatePendingSince = Date.now();
    dbg("到达轮换周期，等待说话间隙执行轮换…");
  }, ROTATE_INTERVAL_MS);
}

function stopRotation() {
  clearInterval(rotationTimer);
  rotationTimer = null;
  rotatePending = false;
}

// 引擎分发：中文普通话按 config.json 的 realtimeEngine 选择云引擎
// （讯飞真流式 / Groq 伪流式），凭据缺失自动回退可用引擎，都没有则回退
// 浏览器引擎；English / 中文繁体始终用浏览器引擎（免费）。
async function startRecording() {
  if (isRecording) return;
  isRecording = true; // 立即置位：防止异步启动期间重复点击产生多个识别实例
  const lang = els.langSelect.value;
  if (lang === "zh-CN") {
    const engine = await getRealtimeEngine();
    if (engine === "groq") {
      await startGroqSession();
      return;
    }
    if (engine === "iflytek") {
      await startIFlytekSession();
      return;
    }
    dbg("云识别引擎均未配置，回退浏览器内置引擎");
  }
  await startWebSpeechSession();
}

// 依据 /api/asr-status 决定实时引擎：优先 config 指定项，凭据缺失时回退
async function getRealtimeEngine() {
  try {
    const resp = await fetch("./api/asr-status");
    if (!resp.ok) return null;
    const s = await resp.json();
    const want = (s.realtimeEngine || "iflytek").toLowerCase();
    if (want === "groq" && s.groq && typeof GroqASR !== "undefined") return "groq";
    if (want === "iflytek" && s.iflytek && typeof IFlytekASR !== "undefined") {
      return "iflytek";
    }
    // 指定引擎凭据缺失时的回退
    if (s.iflytek && typeof IFlytekASR !== "undefined") return "iflytek";
    if (s.groq && typeof GroqASR !== "undefined") return "groq";
    return null;
  } catch (_) {
    return null;
  }
}

// Groq 伪流式路径（中文普通话）：静音切块批量识别
async function startGroqSession() {
  groqSession = new GroqASR(
    {
      onFinal: (text) => appendFinal(text),
      onInterim: (text) => {
        els.interim.textContent = text;
        if (text) scrollToBottom();
      },
      debug: dbg,
      onFatal: (msg, authExpired) => {
        setRecStatus(msg, "error");
        stopRecording();
        if (authExpired) location.href = "./login.html";
      },
    },
    "zh"
  );
  try {
    await groqSession.start();
  } catch (err) {
    groqSession = null;
    isRecording = false; // startRecording 已提前置位，失败需复位
    if (err && err.name === "NotAllowedError") {
      setMicStatus("权限被拒绝", "error");
      setRecStatus("请在浏览器地址栏允许麦克风后重试", "error");
    } else {
      setRecStatus("Groq 引擎启动失败：" + err.message, "error");
    }
    dbg(`Groq 引擎启动失败: ${(err && err.name) || ""} ${err && err.message}`);
    return;
  }
  isRecording = true;
  asrEngine = "groq";
  micGranted = true;
  setMicStatus("已授权", "active");
  setRecStatus("识别中…（Groq 引擎）", "active");
  setControls(true);
  dbg("开始识别 [groq] (zh-CN)");
}

// 浏览器 Web Speech API 路径
async function startWebSpeechSession() {
  const granted = await requestMicPermission();
  if (!granted) {
    isRecording = false; // startRecording 已提前置位，失败需复位
    return;
  }

  isRecording = true;
  asrEngine = "webspeech";
  restartAttempts = 0;
  recognition = createRecognition();
  try {
    recognition.start();
  } catch (err) {
    isRecording = false;
    asrEngine = null;
    setRecStatus("启动失败：" + err.message, "error");
    dbg(`启动失败: ${err.name} ${err.message}`);
    return;
  }
  startWatchdog();
  startRotation();
  setRecStatus("识别中…（浏览器引擎）", "active");
  setControls(true);
  dbg(`开始识别 [webspeech] (lang=${els.langSelect.value})`);
}

// 讯飞听写路径（中文普通话）：音频采集、会话轮换与无缝重连由 IFlytekASR 负责
async function startIFlytekSession() {
  iflytekSession = new IFlytekASR({
    onFinal: (text) => appendFinal(text),
    onInterim: (text) => {
      els.interim.textContent = text;
      if (text) scrollToBottom();
    },
    debug: dbg,
    onFatal: (msg, authExpired) => {
      setRecStatus(msg, "error");
      stopRecording();
      if (authExpired) location.href = "./login.html";
    },
  });
  try {
    await iflytekSession.start();
  } catch (err) {
    iflytekSession = null;
    isRecording = false; // startRecording 已提前置位，失败需复位
    if (err && err.name === "NotAllowedError") {
      setMicStatus("权限被拒绝", "error");
      setRecStatus("请在浏览器地址栏允许麦克风后重试", "error");
    } else {
      setRecStatus("讯飞引擎启动失败：" + err.message, "error");
    }
    dbg(`讯飞引擎启动失败: ${(err && err.name) || ""} ${err && err.message}`);
    return;
  }
  isRecording = true;
  asrEngine = "iflytek";
  micGranted = true;
  setMicStatus("已授权", "active");
  setRecStatus("识别中…（讯飞引擎）", "active");
  setControls(true);
  dbg("开始识别 [iflytek] (zh-CN)");
}

function stopRecording() {
  isRecording = false;
  clearTimeout(restartTimer);
  stopWatchdog();
  stopRotation();
  if (asrEngine === "iflytek" && iflytekSession) {
    iflytekSession.stop();
    iflytekSession = null;
  }
  if (groqSession) {
    groqSession.stop();
    groqSession = null;
  }
  if (recognition) {
    try {
      recognition.stop(); // 触发 onend，其中负责复位状态
    } catch (_) {
      /* 已停止 */
    }
    recognition = null;
  }
  asrEngine = null;
  setRecStatus("空闲");
  setControls(false);
  els.interim.textContent = "";
  dbg("用户手动停止识别");
}

function clearTranscript() {
  els.transcript.innerHTML = "";
  const p = document.createElement("p");
  p.className = "placeholder";
  p.dataset.i18n = "transcript-placeholder";
  p.textContent = window.i18nT
    ? window.i18nT("transcript-placeholder")
    : "点击「开始识别」，授权麦克风后说话，文字将实时显示在这里……";
  els.transcript.appendChild(p);
  els.interim.textContent = "";
}

// ---------- 文本整理 ----------

// 把逐句的识别结果合并为连续文本：
// 中文为主时直接拼接（中文不需要词间空格），英文为主时以空格连接。
function organizeText() {
  const segments = [...els.transcript.querySelectorAll("p:not(.placeholder)")]
    .map((p) => p.textContent.trim())
    .filter(Boolean);

  if (!segments.length) {
    dbg("整理：没有可整理的识别内容");
    els.organized.placeholder = "左侧还没有识别内容，请先录音。";
    return;
  }

  const raw = segments.join(" ");
  const cjkCount = (raw.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || [])
    .length;
  const isCjk = cjkCount > raw.length * 0.2;

  let text;
  if (isCjk) {
    // 中文：去掉所有空白（识别引擎在中文里常插入多余空格）
    text = raw.replace(/\s+/g, "");
  } else {
    // 英文：压缩多余空格，保证句读标点后恰好一个空格
    text = raw
      .replace(/\s+/g, " ")
      .replace(/\s+([,.!?;:%)])/g, "$1")
      .replace(/([(])\s+/g, "$1")
      .replace(/([,.!?;:])(?=\S)/g, "$1 ");
  }

  pushOrganizeHistory();
  els.organized.value = text;
  refreshConvertBtn();
  dbg(`整理完成：${segments.length} 个片段 → ${text.length} 字符（${isCjk ? "中文" : "英文"}模式）`);
}

// ---------- 撤销：程序化覆盖前的文本快照 ----------

const organizeHistory = []; // 撤销栈：整理/AI/转写覆盖文本框前的内容
const ORGANIZE_HISTORY_MAX = 20;

function pushOrganizeHistory() {
  organizeHistory.push(els.organized.value);
  if (organizeHistory.length > ORGANIZE_HISTORY_MAX) organizeHistory.shift();
  els.undoBtn.disabled = false;
}

function undoOrganize() {
  if (!organizeHistory.length) return;
  els.organized.value = organizeHistory.pop();
  if (!organizeHistory.length) els.undoBtn.disabled = true;
  setRecStatus("已恢复上一步内容");
  dbg(`撤销：恢复到上一版（剩余可撤销 ${organizeHistory.length} 步）`);
  refreshConvertBtn();
}

// 文本框被程序化改写后，刷新繁简转换按钮状态（zh-convert.js 提供）
function refreshConvertBtn() {
  if (window.zhConvertRefresh) window.zhConvertRefresh();
}

// ---------- 保存 ----------

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Markdown 行内样式（先转义 HTML，再套用粗体/斜体/行内代码）
function inlineMd(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// Markdown 子集 → HTML：# 标题、-/* 无序列表（按缩进嵌套）、1. 有序列表、
// 其余非空行 → 段落。AI 整理/归纳的输出经此转换后保存为 Word 可读的样式。
function markdownToHtml(md) {
  const html = [];
  const listStack = []; // { type: 'ul'|'ol', indent }
  const closeAll = () => {
    while (listStack.length) {
      html.push(listStack.pop().type === "ul" ? "</ul>" : "</ol>");
    }
  };

  for (const rawLine of md.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) {
      closeAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeAll();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMd(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const m = bullet || numbered;
      const indent = m[1].replace(/\t/g, "  ").length;
      const type = bullet ? "ul" : "ol";
      // 关闭更深或同级但类型不同的列表
      while (listStack.length) {
        const top = listStack[listStack.length - 1];
        if (top.indent < indent) break;
        if (top.indent === indent && top.type === type) break;
        html.push(top.type === "ul" ? "</ul>" : "</ol>");
        listStack.pop();
      }
      // 需要开启新一层列表
      if (
        !listStack.length ||
        listStack[listStack.length - 1].indent < indent
      ) {
        listStack.push({ type, indent });
        html.push(type === "ul" ? "<ul>" : "<ol>");
      }
      html.push(`<li>${inlineMd(escapeHtml(m[2].trim()))}</li>`);
      continue;
    }

    closeAll();
    html.push(`<p>${inlineMd(escapeHtml(line.trim()))}</p>`);
  }
  closeAll();
  return html.join("\n");
}

// Word .doc：生成 Word 兼容的 HTML 文档（.doc 后缀），Word/WPS 可直接打开。
// 支持 Markdown 结构转换：标题 → Heading 样式，列表 → 原生 bullet/编号列表。
function buildDocHtml(text) {
  return (
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:w="urn:schemas-microsoft-com:office:word">' +
    '<head><meta charset="utf-8"><title>Voice2Txt</title></head>' +
    `<body>${markdownToHtml(text)}</body></html>`
  );
}

function saveText() {
  const text = els.organized.value.trim();
  if (!text) {
    els.organized.placeholder = "没有可保存的内容，请先整理或手动输入文本。";
    return;
  }
  const format = els.saveFormat.value;
  const base = `voice2txt-${timestamp()}`;
  if (format === "txt") {
    download(`${base}.txt`, "text/plain;charset=utf-8", text);
  } else if (format === "md") {
    download(`${base}.md`, "text/markdown;charset=utf-8", text + "\n");
  } else {
    download(`${base}.doc`, "application/msword", buildDocHtml(text));
  }
  dbg(`已保存 ${base}.${format}（${text.length} 字符）`);
}

// ---------- LLM 整理 / 归纳 ----------
// 调用由 server.js 代理（DeepSeek API Key 只留在服务端，不下发浏览器）。

let llmBusy = false;

async function callLLM(kind, text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let resp;
  try {
    resp = await fetch("./api/llm", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, text }),
    });
  } catch (err) {
    throw new Error(
      err.name === "AbortError" ? "请求超时（90s）" : `网络错误：${err.message}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 401) {
    const err = new Error("登录状态已失效，请重新输入访问密钥");
    err.authExpired = true;
    throw err;
  }
  if (resp.status === 429) {
    const d = await resp.json().catch(() => ({}));
    throw new Error(d.message || "使用过于频繁，请休息一会儿再继续");
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`服务返回 ${resp.status}：${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data.content) throw new Error("服务返回内容为空");
  return {
    content: data.content.trim(),
    engine: data.engine || "",
    switched: !!data.switched,
  };
}

async function runLLM(kind) {
  if (llmBusy) return;

  // 文本框为空但左侧有识别内容时，先自动执行一次本地整理
  let text = els.organized.value.trim();
  if (!text) {
    organizeText();
    text = els.organized.value.trim();
  }
  if (!text) {
    setRecStatus("没有可处理的内容，请先录音", "error");
    return;
  }

  llmBusy = true;
  const btn = kind === "organize" ? els.llmOrganizeBtn : els.llmSummarizeBtn;
  const label = kind === "organize" ? "AI 整理分段" : "AI 归纳摘要";
  btn.disabled = true;
  btn.textContent = "处理中…";
  setRecStatus(`${label}中…`, "active");
  dbg(`LLM ${kind}：发送 ${text.length} 字符`);

  try {
    const result = await callLLM(kind, text);
    pushOrganizeHistory();
    els.organized.value = result.content;
    refreshConvertBtn();
    const note = result.switched ? "（长文本已自动切换 DeepSeek）" : "";
    setRecStatus(`${label}完成${note}`, "active");
    dbg(
      `LLM ${kind} 完成：返回 ${result.content.length} 字符` +
        `（引擎 ${result.engine || "未知"}${result.switched ? "，自动切换" : ""}）`
    );
  } catch (err) {
    setRecStatus(`${label}失败：${err.message}`, "error");
    dbg(`LLM ${kind} 失败：${err.message}`);
    if (err.authExpired) location.href = "./login.html";
  } finally {
    llmBusy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- 音频文件转写（讯飞录音文件转写，服务端代理上传） ----------

let transcribeBusy = false;

function setTranscribeStatus(text, kind) {
  els.transcribeStatus.textContent = text;
  els.transcribeStatus.className = `status-badge${kind ? " " + kind : ""}`;
}

// 用 Audio 元素读取元数据获取时长（秒）；取不到时返回 0 由服务端兜底
function getAudioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? Math.ceil(audio.duration) : 0);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    audio.src = url;
  });
}

// 带上传进度的 POST（fetch 不支持上传进度，退回 XHR）；
// onProgress(loaded, total) 上传中回调，onUploadDone() 上传完成（等待响应）回调
function uploadWithProgress(url, file, onProgress, onUploadDone) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.upload.onload = () => onUploadDone();
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch (_) {
        /* 非 JSON 响应 */
      }
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        data,
      });
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.ontimeout = () => reject(new Error("上传超时"));
    xhr.timeout = 15 * 60 * 1000;
    xhr.send(file);
  });
}

// 预估等待时间的人类可读格式
function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 90) return `${Math.ceil(sec)} 秒`;
  return `约 ${Math.ceil(sec / 60)} 分钟`;
}

async function transcribeAudioFile() {
  if (transcribeBusy) return;
  const file = els.audioFile.files && els.audioFile.files[0];
  if (!file) {
    setTranscribeStatus("请先选择音频文件", "error");
    return;
  }
  if (file.size > 128 * 1024 * 1024) {
    setTranscribeStatus("文件大小超限（最大 100MB）", "error");
    return;
  }

  transcribeBusy = true;
  els.transcribeBtn.disabled = true;
  let etaTimer = null;
  try {
    setTranscribeStatus("读取文件信息…");
    const duration = await getAudioDuration(file);
    const language = els.langSelect.value.startsWith("zh") ? "cn" : "en";
    dbg(
      `文件转写：${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB，${duration}s，${language}）`
    );

    // 动态预估等待：上传阶段按实测速度算剩余；处理阶段按时长粗估
    // （>25MB 服务端需先转码 ≈ duration/60，识别 ≈ duration/50，下限 8s），每 2s 刷新
    const needCompress = file.size > 25 * 1024 * 1024;
    const processEst = Math.max(8, (needCompress ? duration / 60 : 0) + duration / 50);
    const processLabel = needCompress ? "转码并转写中" : "转写中";
    let phase = "upload";
    let phaseStart = Date.now();
    let lastLoaded = 0;

    etaTimer = setInterval(() => {
      const elapsed = (Date.now() - phaseStart) / 1000;
      if (phase === "upload") {
        const pct = lastLoaded ? Math.round((lastLoaded / file.size) * 100) : 0;
        const speed = elapsed > 0 ? lastLoaded / elapsed : 0;
        const eta = speed > 0 ? (file.size - lastLoaded) / speed : Infinity;
        setTranscribeStatus(
          pct > 0 && Number.isFinite(eta)
            ? `上传中… ${pct}%（约还需 ${fmtEta(eta)}）`
            : "上传中…",
          "active"
        );
      } else {
        const remain = processEst - elapsed;
        setTranscribeStatus(
          remain > 0
            ? `${processLabel}…（约还需 ${fmtEta(remain)}）`
            : `${processLabel}…（即将完成）`,
          "active"
        );
      }
    }, 2000);

    setTranscribeStatus("上传中…", "active");
    const uploadResp = await uploadWithProgress(
      `./api/transcribe?fileName=${encodeURIComponent(file.name)}&duration=${duration}&language=${language}`,
      file,
      (loaded) => {
        lastLoaded = loaded;
      },
      () => {
        phase = "process";
        phaseStart = Date.now();
      }
    );
    if (uploadResp.status === 401) {
      location.href = "./login.html";
      return;
    }
    // 响应已到达；同步引擎（Groq）等待时间已计入，异步引擎（讯飞）走下方轮询文案
    clearInterval(etaTimer);
    etaTimer = null;
    const uploadData = uploadResp.data;
    if (!uploadResp.ok) {
      throw new Error(uploadData.error || `上传失败（HTTP ${uploadResp.status}）`);
    }

    // 同步引擎（Groq）：上传即返回全文，无需轮询
    if (uploadData.done) {
      const sentences = uploadData.sentences || [];
      if (!sentences.length) throw new Error("转写结果为空");
      // 与实时听写一致：先载入左侧识别文本框，再由用户整理到右侧
      sentences.forEach((s) => appendFinal(s));
      refreshConvertBtn();
      setTranscribeStatus(`转写完成（${sentences.length} 句）`, "active");
      dbg(`文件转写完成（同步引擎）：${sentences.length} 句`);
      return;
    }

    // 轮询结果（每 3s，最长 10 分钟）
    const orderId = uploadData.orderId;
    setTranscribeStatus("转写中…", "active");
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const resultResp = await fetch(
        `./api/transcribe-result?orderId=${encodeURIComponent(orderId)}`
      );
      if (resultResp.status === 401) {
        location.href = "./login.html";
        return;
      }
      const data = await resultResp.json().catch(() => ({}));
      if (!resultResp.ok) {
        throw new Error(data.error || `查询失败（HTTP ${resultResp.status}）`);
      }
      if (data.state === "done") {
        const sentences = data.sentences || [];
        if (!sentences.length) throw new Error("转写结果为空");
        // 与实时听写一致：先载入左侧识别文本框，再由用户整理到右侧
        sentences.forEach((s) => appendFinal(s));
        refreshConvertBtn();
        setTranscribeStatus(`转写完成（${sentences.length} 句）`, "active");
        dbg(`文件转写完成：${sentences.length} 句`);
        break;
      }
      if (data.state === "failed") {
        throw new Error(data.error || "转写失败");
      }
      if (Date.now() > deadline) {
        throw new Error("转写超时（10 分钟），请稍后在讯飞控制台查看任务");
      }
    }
  } catch (err) {
    setTranscribeStatus(err.message, "error");
    dbg(`文件转写失败：${err.message}`);
  } finally {
    if (etaTimer) clearInterval(etaTimer);
    transcribeBusy = false;
    els.transcribeBtn.disabled = false;
  }
}

// ---------- 登录态校验与初始化 ----------
// 应用页面与接口均由服务端白名单门禁保护，这里的会话校验是纵深防御：
// 校验未通过（或 Cookie 过期）直接跳转登录页。

async function checkAuth() {
  try {
    const resp = await fetch("./api/session");
    const data = await resp.json();
    if (data.ok) {
      els.appMain.hidden = false;
      if (!SpeechRecognition) {
        els.warning.hidden = false;
        els.startBtn.disabled = true;
      }
      return;
    }
  } catch (_) {
    /* 服务不可达也按未登录处理 */
  }
  location.href = "./login.html";
}

function init() {
  els.startBtn.addEventListener("click", startRecording);
  els.stopBtn.addEventListener("click", stopRecording);
  els.clearBtn.addEventListener("click", clearTranscript);
  els.organizeBtn.addEventListener("click", organizeText);
  els.llmOrganizeBtn.addEventListener("click", () => runLLM("organize"));
  els.llmSummarizeBtn.addEventListener("click", () => runLLM("summarize"));
  els.saveBtn.addEventListener("click", saveText);
  els.undoBtn.addEventListener("click", undoOrganize);
  els.transcribeBtn.addEventListener("click", transcribeAudioFile);
  els.audioFile.addEventListener("change", () => {
    const f = els.audioFile.files && els.audioFile.files[0];
    setTranscribeStatus(f ? `已选择：${f.name}` : "未选择文件");
  });
  checkAuth();
}

init();
