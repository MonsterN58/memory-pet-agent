import type { BrowserWindow } from "electron";

export function sendToLiveWindow(
  window: BrowserWindow | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  try {
    window.webContents.send(channel, ...args);
    return true;
  } catch {
    return false;
  }
}

export function hidePetWindow(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  try {
    sendToLiveWindow(window, "ui:command", "suspend");
  } finally {
    window.hide();
  }
}
