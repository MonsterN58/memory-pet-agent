import type { BrowserWindow } from "electron";

export function hidePetWindow(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  try {
    if (!window.webContents.isDestroyed()) window.webContents.send("ui:command", "suspend");
  } catch {
    // A crashed Renderer must not leave a close-prevented pet window on screen.
  } finally {
    window.hide();
  }
}
