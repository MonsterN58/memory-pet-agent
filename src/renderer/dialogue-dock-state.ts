export type DialogueDockPresentation = "hidden" | "caption" | "expanded";
export type DialogueDismissReason = "auto" | "escape" | "blur" | "drag";
export type DialogueActivity = "ready" | "thinking" | "listening" | "recognizing" | "confirming" | "working" | "error";

export interface DialogueActivityCopy {
  label: string;
  detail: string;
}

export class DialogueDockState {
  private currentPresentation: DialogueDockPresentation = "hidden";
  private busy = false;
  private voiceActive = false;
  private pendingAction = false;
  private focusWithin = false;

  presentation(): DialogueDockPresentation {
    return this.currentPresentation;
  }

  expand(): DialogueDockPresentation {
    this.currentPresentation = "expanded";
    return this.currentPresentation;
  }

  showCaption(): DialogueDockPresentation {
    this.currentPresentation = this.busy || this.voiceActive || this.pendingAction || this.focusWithin
      ? "expanded"
      : "caption";
    return this.currentPresentation;
  }

  setBusy(active: boolean): void {
    this.busy = active;
  }

  setVoiceActive(active: boolean): void {
    this.voiceActive = active;
  }

  setPendingAction(active: boolean): void {
    this.pendingAction = active;
  }

  setFocusWithin(active: boolean): void {
    this.focusWithin = active;
  }

  requestHide(reason: DialogueDismissReason): boolean {
    if (reason === "auto" && (this.busy || this.voiceActive || this.pendingAction || this.focusWithin)) {
      return false;
    }
    this.currentPresentation = "hidden";
    return true;
  }
}

export function dialogueActivityCopy(activity: DialogueActivity): DialogueActivityCopy {
  switch (activity) {
    case "thinking": return { label: "正在想怎么回应", detail: "让我顺着你的话想一想…" };
    case "listening": return { label: "正在听你说", detail: "再点一次麦克风，就会结束录音" };
    case "recognizing": return { label: "正在辨认语音", detail: "语音正在本机整理成文字…" };
    case "confirming": return { label: "有件事等你确认", detail: "你点头以后，我才会继续操作" };
    case "working": return { label: "正在处理这项操作", detail: "参数已经固定，完成后会告诉你" };
    case "error": return { label: "刚才没接住", detail: "没关系，可以直接再试一次" };
    case "ready": return { label: "随时听你说", detail: "我在这里，不着急。" };
    default: {
      const exhaustive: never = activity;
      throw new Error(`未知对话状态：${String(exhaustive)}`);
    }
  }
}
