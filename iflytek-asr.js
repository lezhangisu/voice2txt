/**
 * Voice2Txt — 讯飞语音听写（流式版）真流式实时识别引擎
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// 讯飞语音听写（流式版）前端引擎。
// 音频链路：getUserMedia → AudioWorklet（Float32）→ 主线程累积 40ms 帧
//   → 降采样到 16kHz → Int16 PCM → base64 → WebSocket 直连讯飞。
// 签名 URL 由本地 server.js 生成，SecretKey 不出现在浏览器端。
//
// 关键设计：
// - 讯飞单会话最长 60s，因此做“停顿感知轮换”：45s 标记待轮换，检测到
//   说话间隙（RMS 静音 ≥800ms）就结算重连；55s 强制。重连期间的音频
//   会缓存在队列里，连接恢复后补发，做到真正无缝、不丢字。
// - 开启动态修正（dwa=wpgs）：句内结果会以 pgs=apd/rpl 渐进返回，
//   rpl 按 rg 区间替换未落定的尾部，实现“流动”显示；
//   遇到句末标点（。！？!?）即提交为正文段落。

const IFLYTEK_TARGET_RATE = 16000;
const IFLYTEK_FRAME_MS = 40; // 每帧音频时长
const IFLYTEK_ROTATE_MARK_MS = 45000; // 会话达到该时长标记待轮换
const IFLYTEK_ROTATE_FORCE_MS = 55000; // 超过该时长强制轮换（上限 60s）
const IFLYTEK_SILENCE_MS = 800; // 连续静音达到该时长视为说话间隙
const IFLYTEK_SILENCE_RMS = 0.008; // 静音判定阈值
const IFLYTEK_MAX_QUEUE_CHUNKS = 250; // 重连缓冲上限（约 10s 音频）

class IFlytekASR {
  // hooks: { onFinal(text), onInterim(text), debug(msg) }
  constructor(hooks) {
    this.hooks = hooks;
    this.running = false;

    this.ws = null;
    this.appId = null;
    this.firstFrameSent = false;
    this.sessionStartedAt = 0;
    this.sessionEnding = false;
    this.rotatePending = false;

    this.mediaStream = null;
    this.audioCtx = null;
    this.workletNode = null;
    this.pcmAccum = []; // 主线程累积的 Float32 小块
    this.pcmAccumLen = 0;
    this.pcmQueue = []; // ws 未就绪时缓存的 Int16 帧
    this.silenceMs = 0;

    this.results = []; // {sn, text} 有序列表，与讯飞结果序号 sn 对应
    this.committedLen = 0; // results 中已提交为正文的前缀长度

    this.rotationTimer = null;
    this.sessionTimes = []; // 最近 60s 内的会话建立时间，用于熔断
  }

  async start() {
    this.running = true;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });

    // 优先直接请求 16kHz 采样率；不支持时在主线程手动降采样
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: IFLYTEK_TARGET_RATE,
    });
    await this.audioCtx.audioWorklet.addModule("pcm-worklet.js");

    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, "pcm-capture");
    this.workletNode.port.onmessage = (e) => this.onPcmBlock(e.data);
    // 经零增益接到 destination，防止部分浏览器挂起无输出的 worklet
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    source.connect(this.workletNode);
    this.workletNode.connect(mute);
    mute.connect(this.audioCtx.destination);

    await this.openSession();
    this.rotationTimer = setInterval(() => this.checkRotation(), 1000);
    this.hooks.debug("讯飞引擎：音频采集已启动");
  }

  stop() {
    this.running = false;
    clearInterval(this.rotationTimer);
    this.rotationTimer = null;

    this.commitAll();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.sendEndFrame();
        this.ws.close();
      } catch (_) {
        /* 已关闭 */
      }
    }
    this.ws = null;

    if (this.workletNode) this.workletNode.disconnect();
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
    }
    this.hooks.debug("讯飞引擎：已停止");
  }

  // 熔断：标记停止并通过 onFatal 通知外层（外层随后调用 stop() 完成清理）。
  // authExpired=true 表示登录态失效，外层应跳转登录页。
  fatal(msg, authExpired) {
    this.hooks.debug(`fatal: ${msg}`);
    this.running = false;
    clearInterval(this.rotationTimer);
    this.rotationTimer = null;
    if (this.hooks.onFatal) this.hooks.onFatal(msg, authExpired);
  }

  // ---------- 会话管理 ----------

  async openSession() {
    let url, appId;
    try {
      const resp = await fetch("./api/iflytek-sign");
      if (resp.status === 401) {
        this.fatal("访问密钥无效或已过期，请重新登录。", true);
        return;
      }
      if (!resp.ok) throw new Error(`签名接口返回 ${resp.status}`);
      ({ url, appId } = await resp.json());
    } catch (err) {
      this.hooks.debug(`获取签名失败：${err.message}，1s 后重试`);
      if (this.running) {
        setTimeout(() => this.running && this.openSession(), 1000);
      }
      return;
    }
    this.appId = appId;

    const ws = new WebSocket(url);
    this.ws = ws;
    this.firstFrameSent = false;
    this.sessionEnding = false;

    ws.onopen = () => {
      // 会话频率熔断：60s 内建立超过 5 个会话，说明在异常重连
      // （鉴权/参数/协议问题）。讯飞体验套餐按会话数计用量，
      // 放任重连会持续消耗额度，必须停止并提示。
      const now = Date.now();
      this.sessionTimes = this.sessionTimes.filter((t) => now - t < 60000);
      this.sessionTimes.push(now);
      this.hooks.debug(
        `讯飞会话已建立（最近 60s 内第 ${this.sessionTimes.length} 次）`
      );
      if (this.sessionTimes.length > 5) {
        this.fatal(
          "讯飞会话在 60s 内反复断开重连超过 5 次，已自动停止以保护用量额度。" +
            "请开启调试模式重试，把日志中的 WebSocket 关闭码发给开发者定位。"
        );
        try {
          ws.close();
        } catch (_) {
          /* 已关闭 */
        }
        return;
      }
      this.sessionStartedAt = Date.now();
      this.rotatePending = false;
      this.flushQueue();
    };

    ws.onmessage = (e) => this.onWsMessage(e);

    ws.onerror = () => {
      this.hooks.debug("讯飞 WebSocket 错误（详见服务端/网络）");
    };

    ws.onclose = (e) => {
      this.hooks.debug(
        `讯飞 WebSocket 已关闭 code=${e.code} reason=${e.reason || "(无)"} wasClean=${e.wasClean}`
      );
      if (!this.running) return;
      // 无论是轮换还是意外断开：保住未落定的文本，重置会话状态后重连。
      // 断开期间的音频一直在 pcmQueue 缓存，重连后补发，不丢字。
      this.commitAll();
      this.results = [];
      this.committedLen = 0;
      this.sessionEnding = false;
      setTimeout(() => this.running && this.openSession(), 300);
    };
  }

  // 停顿感知轮换：45s 标记，静音间隙执行，55s 强制（讯飞单会话上限 60s）
  checkRotation() {
    if (!this.running || this.sessionEnding || !this.sessionStartedAt) return;
    const age = Date.now() - this.sessionStartedAt;
    if (!this.rotatePending && age > IFLYTEK_ROTATE_MARK_MS) {
      this.rotatePending = true;
      this.hooks.debug("讯飞会话到达轮换周期，等待说话间隙…");
    }
    if (this.rotatePending) {
      const forced = age > IFLYTEK_ROTATE_FORCE_MS;
      const silent = this.silenceMs >= IFLYTEK_SILENCE_MS;
      if (forced || silent) {
        this.hooks.debug(
          `讯飞会话轮换（${forced ? "强制" : "说话间隙"}）：发送结束帧并重连`
        );
        this.sessionEnding = true;
        this.sendEndFrame();
        // 收到 data.status=2 后由 onmessage 关闭；超时兜底强制关闭
        setTimeout(() => {
          if (this.sessionEnding && this.ws) {
            try {
              this.ws.close();
            } catch (_) {
              /* 已关闭 */
            }
          }
        }, 2000);
      }
    }
  }

  // ---------- 音频处理 ----------

  onPcmBlock(float32) {
    if (!this.running) return;
    this.pcmAccum.push(float32);
    this.pcmAccumLen += float32.length;

    const frameSamples = (IFLYTEK_FRAME_MS / 1000) * this.audioCtx.sampleRate;
    while (this.pcmAccumLen >= frameSamples) {
      const chunk = this.takeSamples(frameSamples);
      this.processFrame(chunk);
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
    // 静音检测（用于停顿感知轮换）
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    this.silenceMs =
      rms < IFLYTEK_SILENCE_RMS ? this.silenceMs + IFLYTEK_FRAME_MS : 0;

    const pcm16 = this.toPcm16(chunk);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.sessionEnding) {
      this.sendAudioFrame(pcm16);
    } else {
      // ws 未就绪/正在轮换：缓存音频，重连后补发（无缝的关键）
      this.pcmQueue.push(pcm16);
      if (this.pcmQueue.length > IFLYTEK_MAX_QUEUE_CHUNKS) {
        this.pcmQueue.shift(); // 极端情况下丢弃最旧的
      }
    }
  }

  toPcm16(float32) {
    // 手动降采样（AudioContext 未按 16kHz 创建时）
    let samples = float32;
    const ratio = this.audioCtx.sampleRate / IFLYTEK_TARGET_RATE;
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

  flushQueue() {
    if (!this.pcmQueue.length) return;
    this.hooks.debug(`补发重连期间缓存的 ${this.pcmQueue.length} 帧音频`);
    for (const pcm of this.pcmQueue.splice(0)) {
      this.sendAudioFrame(pcm);
    }
  }

  // ---------- 讯飞协议 ----------

  sendAudioFrame(pcm16) {
    const audio = this.base64Encode(pcm16);
    let frame;
    if (!this.firstFrameSent) {
      frame = {
        common: { app_id: this.appId },
        business: {
          language: "zh_cn",
          domain: "iat",
          accent: "mandarin",
          dwa: "wpgs", // 动态修正：句内渐进返回 + rpl 替换
          ptt: 1, // 返回标点
        },
        data: {
          status: 0,
          format: "audio/L16;rate=16000",
          encoding: "raw",
          audio,
        },
      };
      this.firstFrameSent = true;
    } else {
      frame = {
        data: {
          status: 1,
          format: "audio/L16;rate=16000",
          encoding: "raw",
          audio,
        },
      };
    }
    this.ws.send(JSON.stringify(frame));
  }

  sendEndFrame() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.firstFrameSent) {
      // 本会话还没有任何音频，直接关闭即可
      try {
        this.ws.close();
      } catch (_) {
        /* 已关闭 */
      }
      return;
    }
    this.ws.send(
      JSON.stringify({
        data: {
          status: 2,
          format: "audio/L16;rate=16000",
          encoding: "raw",
          audio: "",
        },
      })
    );
  }

  onWsMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (msg.code !== 0) {
      this.hooks.debug(`讯飞返回错误: code=${msg.code} message=${msg.message}`);
      // 出错时关闭会话，由 onclose 走重连（音频有缓存，不丢字）
      if (!this.sessionEnding && this.ws) {
        try {
          this.ws.close();
        } catch (_) {
          /* 已关闭 */
        }
      }
      return;
    }

    const data = msg.data || {};
    if (data.result) this.applyResult(data.result);

    if (data.status === 2) {
      // 会话的最后一帧结果
      this.commitAll();
      if (this.sessionEnding && this.ws) {
        try {
          this.ws.close(); // 触发 onclose → 重连新会话
        } catch (_) {
          /* 已关闭 */
        }
      }
    }
  }

  // 动态修正结果拼装。
  // 协议要点（经真实日志验证）：apd 追加新结果；rpl 用当前结果替换 rg 区间。
  // 关键：rg 引用的是结果的“序号 sn”（讯飞从 1 起整场递增），不是数组下标——
  // 因此用 {sn, text} 列表维护，按 sn 定位替换区间，与讯飞的序号体系对齐。
  applyResult(result) {
    const text = (result.ws || [])
      .map((ws) => (ws.cw || []).map((cw) => cw.w).join(""))
      .join("");
    if (!text) return;

    const sn = typeof result.sn === "number" ? result.sn : null;
    this.hooks.debug(
      `result: pgs=${result.pgs || "-"} rg=${JSON.stringify(result.rg || null)} ` +
        `sn=${sn ?? "-"} text="${text.length > 40 ? text.slice(0, 40) + "…" : text}"`
    );

    if (result.pgs === "rpl" && Array.isArray(result.rg) && sn !== null) {
      const [rgStart, rgEnd] = result.rg;
      // 找到 sn 落入 [rgStart, rgEnd] 的条目区间并原位替换；
      // 下界夹紧到 committedLen，保护已提交的正文段落
      let i = this.results.findIndex((en) => en.sn >= rgStart);
      if (i === -1) {
        this.results.push({ sn, text }); // 区间未命中（不应发生），追加兜底
      } else {
        if (i < this.committedLen) i = this.committedLen;
        let j = i;
        while (j + 1 < this.results.length && this.results[j + 1].sn <= rgEnd) {
          j++;
        }
        this.results.splice(i, j - i + 1, { sn, text });
      }
    } else {
      // apd / 无序号：作为新结果追加到尾部
      const lastSn = this.results.length
        ? this.results[this.results.length - 1].sn
        : 0;
      this.results.push({ sn: sn !== null ? sn : lastSn + 1, text });
    }

    const uncommitted = this.results
      .slice(this.committedLen)
      .map((en) => en.text)
      .join("");
    if (/[。！？!?…]$/.test(uncommitted)) {
      // 句末标点 → 提交为正文段落
      this.hooks.onFinal(uncommitted);
      this.hooks.debug(`final: "${uncommitted}"`);
      this.committedLen = this.results.length;
      this.hooks.onInterim("");
    } else {
      this.hooks.onInterim(uncommitted);
    }
  }

  commitAll() {
    const rest = this.results
      .slice(this.committedLen)
      .map((en) => en.text)
      .join("");
    if (rest) {
      this.hooks.onFinal(rest);
      this.hooks.debug(`final（会话结算）: "${rest}"`);
      this.committedLen = this.results.length;
    }
    this.hooks.onInterim("");
  }

  base64Encode(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
}
