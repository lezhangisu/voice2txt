/**
 * Voice2Txt — Groq 伪流式实时识别引擎（静音切块 + 批量转写）
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// Groq 伪流式实时识别引擎。
// Groq 没有真正的流式 ASR（只有批量转写接口），本引擎把麦克风采集的 PCM
// 按“说话停顿”切块：检测到 ≥800ms 静音（且语音 ≥0.5s）或单块达到 15s 即
// 编码为 WAV，经本地 server 转发 Groq 批量识别，结果按句落入正文。
// hooks 接口与 IFlytekASR 一致：{ onFinal, onInterim, debug, onFatal }。

const GROQ_RT_RATE = 16000;
const GROQ_RT_FRAME_MS = 40;
const GROQ_RT_SILENCE_MS = 800; // 停顿达到该时长即切块发送
const GROQ_RT_SILENCE_RMS = 0.008; // 静音判定阈值
const GROQ_RT_MIN_SPEECH_MS = 500; // 短于该时长的块直接丢弃（防喷麦/环境噪音）
const GROQ_RT_MAX_SPEECH_MS = 15000; // 单块最长时长，防缓冲无限增长
const GROQ_RT_RETRY_MS = 20000; // 触发限速后的重试间隔

class GroqASR {
  constructor(hooks, language) {
    this.hooks = hooks;
    this.language = language || "zh";
    this.running = false;

    this.mediaStream = null;
    this.audioCtx = null;
    this.workletNode = null;
    this.pcmAccum = [];
    this.pcmAccumLen = 0;

    this.speechChunks = []; // 当前话语块的 Int16 帧
    this.speechMs = 0;
    this.silenceMs = 0;
    this.flushing = false;
    this.retryTimer = null;
  }

  async start() {
    this.running = true;
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: GROQ_RT_RATE,
    });
    await this.audioCtx.audioWorklet.addModule("pcm-worklet.js");

    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-capture");
    this.workletNode.port.onmessage = (e) => this.onPcmBlock(e.data);
    // 零增益接 destination，防止部分浏览器挂起无输出的 worklet
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    source.connect(this.workletNode);
    this.workletNode.connect(mute);
    mute.connect(this.audioCtx.destination);
    this.hooks.debug("Groq 引擎：音频采集已启动（静音切块批量识别）");
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    // 收尾：把未发送的语音块发出（尽力而为）
    if (this.speechMs >= GROQ_RT_MIN_SPEECH_MS) this.flush();
    if (this.workletNode) this.workletNode.disconnect();
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
    }
    this.hooks.debug("Groq 引擎：已停止");
  }

  onPcmBlock(float32) {
    if (!this.running) return;
    this.pcmAccum.push(float32);
    this.pcmAccumLen += float32.length;
    const frameSamples = (GROQ_RT_FRAME_MS / 1000) * this.audioCtx.sampleRate;
    while (this.pcmAccumLen >= frameSamples) {
      this.processFrame(this.takeSamples(frameSamples));
    }
  }

  takeSamples(n) {
    const out = new Float32Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.pcmAccum[0];
      const take = Math.min(head.length, n - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.length) this.pcmAccum.shift();
      else this.pcmAccum[0] = head.subarray(take);
    }
    this.pcmAccumLen -= n;
    return out;
  }

  processFrame(chunk) {
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    const silent = rms < GROQ_RT_SILENCE_RMS;

    // 语音进行中（或已开始的话语块内）才累积，纯静音不占识别额度
    if (!silent || this.speechChunks.length) {
      this.speechChunks.push(this.toPcm16(chunk));
      this.speechMs += GROQ_RT_FRAME_MS;
    }
    this.silenceMs = silent ? this.silenceMs + GROQ_RT_FRAME_MS : 0;

    if (
      this.speechMs >= GROQ_RT_MIN_SPEECH_MS &&
      (this.silenceMs >= GROQ_RT_SILENCE_MS ||
        this.speechMs >= GROQ_RT_MAX_SPEECH_MS)
    ) {
      this.flush();
    }
  }

  toPcm16(float32) {
    let samples = float32;
    const ratio = this.audioCtx.sampleRate / GROQ_RT_RATE;
    if (ratio > 1.01) {
      const outLen = Math.floor(float32.length / ratio);
      samples = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        samples[i] = float32[Math.floor(i * ratio)];
      }
    }
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  }

  async flush() {
    if (this.flushing || !this.speechChunks.length) return;
    const chunks = this.speechChunks;
    const ms = this.speechMs;
    this.speechChunks = [];
    this.speechMs = 0;
    this.flushing = true;
    this.hooks.onInterim("识别中…");
    try {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Int16Array(total);
      let off = 0;
      for (const c of chunks) {
        pcm.set(c, off);
        off += c.length;
      }
      const wav = pcm16ToWav(pcm, GROQ_RT_RATE);

      const resp = await fetch(
        `/api/transcribe-chunk?language=${encodeURIComponent(this.language)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: wav,
        }
      );

      if (resp.status === 401) {
        this.hooks.onFatal("访问密钥无效或已过期，请重新登录。", true);
        return;
      }
      if (resp.status === 429) {
        // 触发限速：把块放回队首，稍后随下一波语音一起重发，不丢内容
        const d = await resp.json().catch(() => ({}));
        this.hooks.onInterim(d.message || "已达限速，稍后自动继续…");
        this.hooks.debug(`限速，${GROQ_RT_RETRY_MS / 1000}s 后恢复发送`);
        this.speechChunks = chunks.concat(this.speechChunks);
        this.speechMs += ms;
        await new Promise((r) => {
          this.retryTimer = setTimeout(r, GROQ_RT_RETRY_MS);
        });
        return;
      }

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        // 单块失败丢弃该块（不中断后续识别），错误进日志
        this.hooks.debug(
          `块识别失败（已丢弃 ${Math.round(ms)}ms 音频）：${data.error || resp.status}`
        );
        this.hooks.onInterim("");
        return;
      }
      const text = (data.text || "").trim();
      this.hooks.onInterim("");
      if (text) {
        this.hooks.onFinal(text);
        this.hooks.debug(`final: "${text}"`);
      }
    } catch (err) {
      this.hooks.debug(`块上传失败：${err.message}`);
      this.hooks.onInterim("");
    } finally {
      this.flushing = false;
    }
  }
}

// Int16 PCM → WAV 文件字节（44 字节标准头）
function pcm16ToWav(pcm, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // fmt 块长度
  v.setUint16(20, 1, true); // PCM 编码
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // 字节率
  v.setUint16(32, 2, true); // 块对齐
  v.setUint16(34, 16, true); // 位深
  writeStr(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}
