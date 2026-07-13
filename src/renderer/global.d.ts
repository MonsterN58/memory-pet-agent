import type { PetAgentBridge } from "../common/types";

declare global {
  interface Window {
    petAgent: PetAgentBridge;
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  }

  interface SpeechRecognitionConstructorLike {
    new (): SpeechRecognitionLike;
  }

  interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    start(): void;
    stop(): void;
    abort(): void;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onerror: ((event: { error: string; message?: string }) => void) | null;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  }

  interface SpeechRecognitionEventLike {
    resultIndex: number;
    results: ArrayLike<{
      isFinal: boolean;
      0: { transcript: string; confidence: number };
    }>;
  }
}

export {};
