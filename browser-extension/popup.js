const DEFAULT_ENDPOINT = "http://127.0.0.1:32145";
const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#pairing-token");
const status = document.querySelector("#status");

void chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, pairingToken: "", lastStatus: "" }).then((value) => {
  endpoint.value = value.endpoint;
  token.value = value.pairingToken;
  if (value.lastStatus) status.textContent = value.lastStatus;
});

document.querySelector("#save").addEventListener("click", () => void saveAndTest(true));
document.querySelector("#test").addEventListener("click", () => void saveAndTest(false));

async function saveAndTest(save) {
  try {
    const parsed = parsePairingInput(token.value, endpoint.value);
    endpoint.value = parsed.endpoint;
    token.value = parsed.pairingToken;
    if (save) await chrome.storage.local.set(parsed);
    status.dataset.ok = "pending";
    status.textContent = "正在连接桌宠…";
    const response = await fetch(`${normalizeEndpoint(parsed.endpoint)}/health`, {
      headers: { "X-Memory-Pet-Token": parsed.pairingToken },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `连接返回 ${response.status}`);
    status.dataset.ok = "true";
    status.textContent = "连接成功，现在可以在网页中使用右键菜单。";
  } catch (error) {
    status.dataset.ok = "false";
    status.textContent = error instanceof Error ? error.message : "连接失败";
  }
}

function parsePairingInput(rawToken, rawEndpoint) {
  const value = String(rawToken || "").trim();
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value);
    return {
      endpoint: normalizeEndpoint(parsed.endpoint || rawEndpoint),
      pairingToken: String(parsed.pairingToken || parsed.token || "").trim(),
    };
  }
  if (!value) throw new Error("请粘贴配对令牌");
  return { endpoint: normalizeEndpoint(rawEndpoint), pairingToken: value };
}

function normalizeEndpoint(value) {
  const url = new URL(String(value || DEFAULT_ENDPOINT));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("桥接地址必须是本机 HTTP 地址");
  }
  return url.origin;
}
