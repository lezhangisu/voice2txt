/**
 * Voice2Txt — 登录页逻辑（访问密钥校验与会话跳转）
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// 登录页：校验访问密钥；已登录用户（30 天 HttpOnly Cookie）直接跳转应用。
const form = document.getElementById("login-form");
const keyInput = document.getElementById("key-input");
const keyBtn = document.getElementById("key-btn");
const keyError = document.getElementById("key-error");

function showError(msg) {
  keyError.textContent = msg;
  keyError.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = keyInput.value.trim();
  if (!key) return;
  keyBtn.disabled = true;
  try {
    const resp = await fetch("./api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (resp.ok) {
      location.href = "./";
      return;
    }
    if (resp.status === 429) {
      showError(window.i18nT("err-throttle"));
    } else {
      showError(window.i18nT("err-invalid"));
    }
  } catch (_) {
    showError(window.i18nT("err-network"));
  } finally {
    keyBtn.disabled = false;
  }
});

// 已登录用户无需重复输入，直接进入应用
fetch("./api/session")
  .then((r) => r.json())
  .then((d) => {
    if (d.ok) location.replace("./");
  })
  .catch(() => {
    /* 服务不可达时停留在登录页 */
  });
