/**
 * Voice2Txt — 申请访问页逻辑（密钥申请提交）
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// 申请页：提交名字 / Email / 留言，服务器校验后通过 Gmail SMTP 通知站长。
// 接口免登录，服务端按 IP 限流（3 次/小时）。
const form = document.getElementById("request-form");
const nameInput = document.getElementById("name-input");
const emailInput = document.getElementById("email-input");
const messageInput = document.getElementById("message-input");
const submitBtn = document.getElementById("request-btn");
const result = document.getElementById("request-result");

function showResult(msg, ok) {
  result.textContent = msg;
  result.hidden = false;
  result.classList.toggle("ok", !!ok);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();
  const message = messageInput.value.trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showResult(window.i18nT("err-request-invalid"), false);
    return;
  }
  submitBtn.disabled = true;
  try {
    const resp = await fetch("./api/request-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, message }),
    });
    if (resp.ok) {
      showResult(window.i18nT("request-success"), true);
      nameInput.disabled = true;
      emailInput.disabled = true;
      messageInput.disabled = true;
      return; // 成功后保持按钮禁用，防止重复提交
    }
    if (resp.status === 429) {
      showResult(window.i18nT("err-request-throttle"), false);
    } else if (resp.status === 501) {
      showResult(window.i18nT("err-request-disabled"), false);
    } else if (resp.status === 400) {
      showResult(window.i18nT("err-request-invalid"), false);
    } else {
      showResult(window.i18nT("err-request-fail"), false);
    }
  } catch (_) {
    showResult(window.i18nT("err-network"), false);
  }
  submitBtn.disabled = false;
});
