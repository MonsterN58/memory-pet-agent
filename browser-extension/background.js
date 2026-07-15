const DEFAULT_ENDPOINT = "http://127.0.0.1:32145";

const MENU_ITEMS = [
  { id: "explain-selection", title: "让桌宠解释选中文本", contexts: ["selection"] },
  { id: "summarize-selection", title: "让桌宠总结选中文本", contexts: ["selection"] },
  { id: "chat-selection", title: "和桌宠聊聊选中文本", contexts: ["selection"] },
  { id: "remember-selection", title: "让桌宠记住选中文本", contexts: ["selection"] },
  { id: "summarize-page", title: "让桌宠总结当前网页", contexts: ["page"] },
  { id: "chat-page", title: "和桌宠聊聊当前网页", contexts: ["page"] },
];

chrome.runtime.onInstalled.addListener(() => createMenus());
chrome.runtime.onStartup.addListener(() => createMenus());

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
