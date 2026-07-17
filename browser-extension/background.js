const DEFAULT_ENDPOINT = "http://127.0.0.1:32145";
const COMMAND_POLL_WAIT_MS = 15000;
const COMMAND_RETRY_MS = 3000;
const MAX_COMMAND_TEXT_LENGTH = 200;
const COMMAND_ACTIONS = new Set([
  "reload", "go-back", "go-forward",
  "scroll-up", "scroll-down", "scroll-top", "scroll-bottom", "find-text",
]);

const MENU_ITEMS = [
  { id: "explain-selection", title: "让桌宠解释选中文本", contexts: ["selection"] },
  { id: "summarize-selection", title: "让桌宠总结选中文本", contexts: ["selection"] },
  { id: "chat-selection", title: "和桌宠聊聊选中文本", contexts: ["selection"] },
  { id: "remember-selection", title: "让桌宠记住选中文本", contexts: ["selection"] },
  { id: "summarize-page", title: "让桌宠总结当前网页", contexts: ["page"] },
  { id: "chat-page", title: "和桌宠聊聊当前网页", contexts: ["page"] },
];

chrome.runtime.onInstalled.addListener(() => {
  void createMenus();
  restartCommandPolling();
});
chrome.runtime.onStartup.addListener(() => {
  void createMenus();
  restartCommandPolling();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.endpoint || changes.pairingToken || changes.commandPollingEnabled) restartCommandPolling();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "memory-pet-refresh-command-polling") restartCommandPolling();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void shareFromMenu(info, tab).catch((error) => setStatus(false, error instanceof Error ? error.message : "发送失败"));
});

let menuSetup;
function createMenus() {
  if (menuSetup) return menuSetup;
  menuSetup = (async () => {
    await chrome.contextMenus.removeAll();
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({
        ...item,
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      });
    }
  })().finally(() => { menuSetup = undefined; });
  return menuSetup;
}

async function shareFromMenu(info, tab) {
  if (!tab?.id) throw new Error("当前标签页不可用");
  const action = String(info.menuItemId).split("-")[0];
  const pageContext = String(info.menuItemId).endsWith("-page")
    ? await collectPage(tab.id)
    : {
        text: String(info.selectionText || "").trim(),
        title: tab.title || "",
        url: tab.url || "",
      };
  if (!pageContext.text) throw new Error("没有读到可分享的文字");
  await sendContext({ action, ...pageContext });
  await setStatus(true, "已交给桌宠");
}

async function collectPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const selected = window.getSelection()?.toString().trim() || "";
      const source = document.querySelector("article, main, [role='main']") || document.body;
      const clone = source.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, nav, footer, form, input, textarea, [contenteditable='true']")
        .forEach((element) => element.remove());
      const text = (selected || clone.innerText || clone.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 12000);
      return { text, title: document.title.slice(0, 300), url: location.href };
    },
  });
  return results[0]?.result || { text: "", title: "", url: "" };
}

async function sendContext(context) {
  const config = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, pairingToken: "" });
  if (!config.pairingToken) throw new Error("请先点击扩展图标完成配对");
  const response = await fetch(`${normalizeEndpoint(config.endpoint)}/v1/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Memory-Pet-Token": config.pairingToken,
    },
    body: JSON.stringify(context),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `桌宠桥接返回 ${response.status}`);
}

let pollingGeneration = 0;
let activePollController;
let lastPollingError = "";

function restartCommandPolling() {
  pollingGeneration += 1;
  activePollController?.abort();
  activePollController = undefined;
  void commandPollingLoop(pollingGeneration);
}

async function commandPollingLoop(generation) {
  while (generation === pollingGeneration) {
    const config = await chrome.storage.local.get({
      endpoint: DEFAULT_ENDPOINT,
      pairingToken: "",
      commandPollingEnabled: false,
    });
    const pairingToken = String(config.pairingToken || "").trim();
    if (!pairingToken || config.commandPollingEnabled !== true) return;

    let retryDelay = 150;
    const controller = new AbortController();
    activePollController = controller;
    try {
      const response = await fetch(
        `${normalizeEndpoint(config.endpoint)}/v1/commands/poll?waitMs=${COMMAND_POLL_WAIT_MS}`,
        {
          headers: { "X-Memory-Pet-Token": pairingToken },
          cache: "no-store",
          signal: controller.signal,
        },
      );
      if (generation !== pollingGeneration) return;
      if (response.status === 204) {
        lastPollingError = "";
      } else {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `操作轮询返回 ${response.status}`);
        const command = sanitizeCommand(body.command);
        const result = await executeCommand(command);
        await reportCommandResult(config.endpoint, pairingToken, command.id, result);
        lastPollingError = "";
        await setStatus(result.ok, result.message);
        await chrome.storage.local.set({
          lastCommandStatus: result.message,
          lastCommandStatusOk: result.ok,
          lastCommandStatusAt: Date.now(),
        });
      }
    } catch (error) {
      if (controller.signal.aborted || generation !== pollingGeneration) return;
      retryDelay = COMMAND_RETRY_MS;
      const message = error instanceof Error ? error.message : "浏览器操作轮询失败";
      if (message !== lastPollingError) {
        lastPollingError = message;
        await chrome.storage.local.set({
          lastCommandStatus: message,
          lastCommandStatusOk: false,
          lastCommandStatusAt: Date.now(),
        });
      }
    } finally {
      if (activePollController === controller) activePollController = undefined;
    }
    await delay(retryDelay);
  }
}

function sanitizeCommand(value) {
  if (!value || typeof value !== "object") throw new Error("桌宠发来的操作格式无效");
  const id = String(value.id || "");
  const action = String(value.action || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("桌宠发来的操作编号无效");
  }
  if (!COMMAND_ACTIONS.has(action)) throw new Error("桌宠请求了未知网页操作");
  if (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error("网页操作已经过期");
  if (action !== "find-text") return { id, action };
  if (typeof value.text !== "string") throw new Error("网页查找内容无效");
  const text = value.text.replace(/\u0000/g, "").trim();
  if (!text || text.length > MAX_COMMAND_TEXT_LENGTH) throw new Error("网页查找内容长度无效");
  return { id, action, text };
}

async function executeCommand(command) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("没有可操作的活动标签页");
    const pageCheck = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ supported: location.protocol === "http:" || location.protocol === "https:" }),
    });
    if (pageCheck[0]?.result?.supported !== true) throw new Error("当前标签页不是普通网页");

    if (command.action === "reload") {
      await chrome.tabs.reload(tab.id);
      return { ok: true, message: "已刷新当前网页" };
    }
    if (command.action === "go-back" || command.action === "go-forward") {
      if (command.action === "go-back") await chrome.tabs.goBack(tab.id);
      else await chrome.tabs.goForward(tab.id);
      return { ok: true, message: command.action === "go-back" ? "已返回上一页" : "已前进到下一页" };
    }
    if (command.action === "scroll-top" || command.action === "scroll-bottom") {
      const toBottom = command.action === "scroll-bottom";
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (bottom) => {
          window.scrollTo({ top: bottom ? document.documentElement.scrollHeight : 0, behavior: "smooth" });
        },
        args: [toBottom],
      });
      return { ok: true, message: toBottom ? "已滚动到网页底部" : "已回到网页顶部" };
    }
    if (command.action === "scroll-up" || command.action === "scroll-down") {
      const direction = command.action === "scroll-up" ? -1 : 1;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scrollDirection) => {
          window.scrollBy({
            top: scrollDirection * Math.max(320, Math.round(window.innerHeight * 0.8)),
            behavior: "smooth",
          });
        },
        args: [direction],
      });
      return { ok: true, message: direction < 0 ? "已向上滚动网页" : "已向下滚动网页" };
    }
    const findResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (query) => window.find(query, false, false, true, false, false, false),
      args: [command.text],
    });
    const found = findResult[0]?.result === true;
    return {
      ok: found,
      message: found ? "已定位并选中网页中的文字" : "当前网页里没有找到这段文字",
    };
  } catch (error) {
    return {
      ok: false,
      message: compactError(error),
    };
  }
}

async function reportCommandResult(endpoint, pairingToken, id, result) {
  const response = await fetch(`${normalizeEndpoint(endpoint)}/v1/commands/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Memory-Pet-Token": pairingToken,
    },
    body: JSON.stringify({ id, ok: result.ok, message: result.message }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `操作结果回传返回 ${response.status}`);
  }
}

function compactError(error) {
  const message = error instanceof Error ? error.message : "网页操作执行失败";
  if (/permission|cannot access|not allowed|Missing host permission/i.test(message)) {
    return "请先在目标网页点击一次扩展图标，再让桌宠操作";
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "网页操作执行失败";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setStatus(ok, message) {
  await chrome.storage.local.set({ lastStatus: message, lastStatusOk: ok, lastStatusAt: Date.now() });
  await chrome.action.setBadgeBackgroundColor({ color: ok ? "#4f9f78" : "#cc5f6f" });
  await chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3500);
}

function normalizeEndpoint(value) {
  const url = new URL(String(value || DEFAULT_ENDPOINT));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("桥接地址必须是本机 HTTP 地址");
  }
  return url.origin;
}

restartCommandPolling();
