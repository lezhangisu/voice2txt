/**
 * Voice2Txt — 界面中英文切换（i18n 字典与切换逻辑）
 * Copyright (c) 2026 Le Zhang
 * Licensed under the MIT License. See LICENSE file for details.
 */
"use strict";

// 界面中英切换：扫描 [data-i18n] 属性元素替换文案，localStorage 记住选择。
// 动态状态消息（状态栏、识别进度等由 JS 组装的内容）不在此机制内，保持中文。
const I18N_DICT = {
  zh: {
    "label-language": "识别语言",
    "lang-zh-cn": "中文（普通话）",
    "lang-zh-tw": "中文（繁體）",
    "lang-en": "English",
    "btn-start": "开始识别",
    "btn-stop": "停止",
    "btn-clear": "清空",
    "panel-live": "实时识别",
    "panel-organized": "整理后的文本",
    "transcript-placeholder":
      "点击「开始识别」，授权麦克风后说话，文字将实时显示在这里……",
    "organized-placeholder":
      "录音结束后，点击下方「整理为连续文本」，可在此编辑后保存。",
    "btn-organize": "整理为连续文本",
    "btn-llm-organize": "AI 整理分段",
    "btn-llm-summarize": "AI 归纳摘要",
    "btn-undo": "回到上一步",
    "fmt-txt": "TXT 纯文本",
    "fmt-md": "Markdown",
    "fmt-doc": "Word (.doc)",
    "btn-save": "保存文本",
    "label-file": "音频文件转写",
    "btn-transcribe": "上传并转写",
    "file-size-hint": "最大 100MB",
    "transcribe-status-init": "未选择文件",
    "convert-btn": "繁简转换",
    "convert-to-simp": "转为简体",
    "convert-to-trad": "转为繁体",
    "login-tip": "请输入访问密钥",
    "key-input-placeholder": "访问密钥",
    "btn-enter": "进入",
    "err-invalid": "密钥无效，请重试",
    "err-network": "网络错误，请重试",
    "err-throttle": "尝试次数过多，请 10 分钟后再试",
    "btn-request-access": "没有密钥？申请访问",
    "request-tip": "填写以下信息，申请访问密钥",
    "request-name": "名字",
    "request-email": "Email 地址",
    "request-message": "留言（可选）",
    "btn-request-submit": "提交申请",
    "request-success": "已提交，审核通过后密钥将发送到你的邮箱",
    "request-back-login": "返回登录",
    "err-request-invalid": "请填写名字和有效的 Email 地址",
    "err-request-throttle": "提交过于频繁，请 30 分钟后再试",
    "err-request-fail": "提交失败，请稍后重试",
    "err-request-disabled": "申请通道暂未开放，请联系站长",
  },
  en: {
    "label-language": "Language",
    "lang-zh-cn": "Chinese (Mandarin)",
    "lang-zh-tw": "Chinese (Traditional)",
    "lang-en": "English",
    "btn-start": "Start",
    "btn-stop": "Stop",
    "btn-clear": "Clear",
    "panel-live": "Live Transcript",
    "panel-organized": "Organized Text",
    "transcript-placeholder":
      'Click "Start", allow microphone access, and speak — text will appear here in real time…',
    "organized-placeholder":
      'After recording, click "Merge into Text" below. You can edit here before saving.',
    "btn-organize": "Merge into Text",
    "btn-llm-organize": "AI Structure",
    "btn-llm-summarize": "AI Summarize",
    "btn-undo": "Step Back",
    "fmt-txt": "Plain Text (.txt)",
    "fmt-md": "Markdown",
    "fmt-doc": "Word (.doc)",
    "btn-save": "Save",
    "label-file": "Audio File Transcription",
    "btn-transcribe": "Upload & Transcribe",
    "file-size-hint": "Max 100MB",
    "transcribe-status-init": "No file selected",
    "convert-btn": "繁⇄简",
    "convert-to-simp": "To Simplified",
    "convert-to-trad": "To Traditional",
    "login-tip": "Enter your access key",
    "key-input-placeholder": "Access Key",
    "btn-enter": "Sign In",
    "err-invalid": "Invalid key, please try again",
    "err-network": "Network error, please try again",
    "err-throttle": "Too many attempts, please try again in 10 minutes",
    "btn-request-access": "No key? Request access",
    "request-tip": "Fill in your info to request an access key",
    "request-name": "Your name",
    "request-email": "Email address",
    "request-message": "Message (optional)",
    "btn-request-submit": "Submit Request",
    "request-success":
      "Request submitted. The key will be emailed to you once approved.",
    "request-back-login": "Back to sign in",
    "err-request-invalid": "Please enter your name and a valid email address",
    "err-request-throttle": "Too many requests, please try again in 30 minutes",
    "err-request-fail": "Submission failed, please try again later",
    "err-request-disabled":
      "Requests are not open yet, please contact the site owner",
  },
};

let i18nLang = localStorage.getItem("v2t-lang") || "zh";

function i18nT(key) {
  const dict = I18N_DICT[i18nLang] || I18N_DICT.zh;
  return dict[key] !== undefined ? dict[key] : key;
}
window.i18nT = i18nT;

function applyLang(lang) {
  i18nLang = lang === "en" ? "en" : "zh";
  localStorage.setItem("v2t-lang", i18nLang);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const val = i18nT(el.dataset.i18n);
    if (val === el.dataset.i18n) return;
    if (el.hasAttribute("data-i18n-placeholder")) {
      el.setAttribute("placeholder", val);
    } else {
      el.textContent = val;
    }
  });
  // 同步所有切换钮的状态（登录页 / 主页面各一个）
  document.querySelectorAll(".lang-toggle-input").forEach((t) => {
    t.checked = i18nLang === "en";
  });
  // 繁简转换按钮的文案也跟随界面语言
  if (window.zhConvertRefresh) window.zhConvertRefresh();
}

document.querySelectorAll(".lang-toggle-input").forEach((t) => {
  t.addEventListener("change", () => applyLang(t.checked ? "en" : "zh"));
});
applyLang(i18nLang);
