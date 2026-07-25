/**
 * Voice2Txt — PCM 音频采集 AudioWorklet 处理器
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// PCM 音频采集 AudioWorklet：把每个 128 采样块的 Float32 数据原样
// 转发给主线程（主线程负责累积成 40ms 帧、降采样和编码）。
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice(0));
    }
    return true; // 持续处理
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
