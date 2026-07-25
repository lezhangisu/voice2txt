/**
 * Voice2Txt — 繁简自动检测与双向转换（OpenCC 字级映射）
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// 繁简转换：检测右侧文本框内中文的形体（繁/简），提供双向转换按钮。
// 数据来自 zh-convert-data.js（OpenCC 字级映射），无需网络请求。
(function () {
  const textarea = document.getElementById("organized");
  const btn = document.getElementById("convert-btn");

  // 数据文件未加载（server 未重启导致 404 / 缓存）时明确报错而非静默失效
  if (typeof ZH_ST_DATA === "undefined" || typeof ZH_TS_DATA === "undefined") {
    console.error(
      "[voice2txt] zh-convert-data.js 未加载，繁简转换不可用。" +
        "请重启 server（node server.js）并强制刷新页面（Cmd+Shift+R）。"
    );
    return;
  }
  const CJK_RE = /[\u4e00-\u9fff]/;

  // 统计文本中仅在繁体表 / 仅在简体表出现的字数，判断整体形体
  function analyze(text) {
    let cjk = 0;
    let simp = 0;
    let trad = 0;
    for (const ch of text) {
      if (!CJK_RE.test(ch)) continue;
      cjk++;
      if (Object.prototype.hasOwnProperty.call(ZH_TS_DATA, ch)) trad++;
      else if (Object.prototype.hasOwnProperty.call(ZH_ST_DATA, ch)) simp++;
    }
    return { cjk, simp, trad };
  }

  function convert(text, map) {
    let out = "";
    for (const ch of text) out += map[ch] || ch;
    return out;
  }

  function refresh() {
    const a = analyze(textarea.value);
    if (!a.cjk) {
      btn.disabled = true;
      btn.textContent = window.i18nT("convert-btn");
      btn.dataset.direction = "";
      return;
    }
    btn.disabled = false;
    if (a.trad > a.simp) {
      btn.textContent = window.i18nT("convert-to-simp");
      btn.dataset.direction = "t2s";
    } else {
      btn.textContent = window.i18nT("convert-to-trad");
      btn.dataset.direction = "s2t";
    }
  }

  btn.addEventListener("click", () => {
    const dir = btn.dataset.direction;
    if (!dir) return;
    // 纳入撤销栈，误转换可一键恢复（pushOrganizeHistory 定义于 app.js）
    if (typeof pushOrganizeHistory === "function") pushOrganizeHistory();
    textarea.value = convert(
      textarea.value,
      dir === "t2s" ? ZH_TS_DATA : ZH_ST_DATA
    );
    refresh();
  });

  textarea.addEventListener("input", refresh);

  // 供 app.js 在程序化改写文本框后调用
  window.zhConvertRefresh = refresh;
  refresh();
})();
