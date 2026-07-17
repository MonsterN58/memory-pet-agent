import type { Live2DModelInfo, ModelTemperamentSeed } from "./types";

export interface BundledModelDefinition {
  id: string;
  name: string;
  directory: string;
  settingsFile: string;
  origin: Extract<Live2DModelInfo["origin"], "official-sample" | "third-party">;
  temperamentSeed: ModelTemperamentSeed;
}

export const BUNDLED_MODEL_DEFINITIONS = [
  {
    id: "hiyori",
    name: "Hiyori（Live2D 官方样例）",
    directory: "Hiyori",
    settingsFile: "Hiyori.model3.json",
    origin: "official-sample",
    temperamentSeed: {
      label: "温柔好奇",
      summary: "更愿意先接住感受，再带着一点好奇靠近话题。",
      warmth: 0.74, curiosity: 0.67, playfulness: 0.54,
      directness: 0.43, initiative: 0.56, expressiveness: 0.63,
    },
  },
  {
    id: "mao",
    name: "Mao（Live2D 官方样例）",
    directory: "Mao",
    settingsFile: "Mao.model3.json",
    origin: "official-sample",
    temperamentSeed: {
      label: "活泼爱玩",
      summary: "表达更轻快，碰到新鲜事时容易兴奋，也更愿意开个小玩笑。",
      warmth: 0.64, curiosity: 0.74, playfulness: 0.84,
      directness: 0.58, initiative: 0.69, expressiveness: 0.8,
    },
  },
  {
    id: "wanko",
    name: "Wanko（Live2D 官方宠物样例）",
    directory: "Wanko",
    settingsFile: "Wanko.model3.json",
    origin: "official-sample",
    temperamentSeed: {
      label: "热情直率",
      summary: "反应来得快，开心和关心都会直接表现出来。",
      warmth: 0.73, curiosity: 0.57, playfulness: 0.76,
      directness: 0.75, initiative: 0.72, expressiveness: 0.68,
    },
  },
  {
    id: "haru",
    name: "Haru（Live2D 官方样例）",
    directory: "Haru",
    settingsFile: "Haru.model3.json",
    origin: "official-sample",
    temperamentSeed: {
      label: "开朗细腻",
      summary: "语气明亮，但会留意对方没直接说出口的情绪。",
      warmth: 0.78, curiosity: 0.62, playfulness: 0.67,
      directness: 0.48, initiative: 0.59, expressiveness: 0.76,
    },
  },
  {
    id: "mark",
    name: "Mark（Live2D 官方样例）",
    directory: "Mark",
    settingsFile: "Mark.model3.json",
    origin: "official-sample",
    temperamentSeed: {
      label: "安静稳重",
      summary: "习惯先观察再开口，表达简洁，做事不慌不忙。",
      warmth: 0.52, curiosity: 0.43, playfulness: 0.31,
      directness: 0.61, initiative: 0.37, expressiveness: 0.36,
    },
  },
  {
    id: "nana",
    name: "Nana（CC BY-SA 4.0）",
    directory: "Nana",
    settingsFile: "nana.model3.json",
    origin: "third-party",
    temperamentSeed: {
      label: "清醒温和",
      summary: "说话不绕太多弯，但会把直接和体贴放在一起。",
      warmth: 0.7, curiosity: 0.55, playfulness: 0.4,
      directness: 0.68, initiative: 0.48, expressiveness: 0.5,
    },
  },
  {
    id: "rice",
    name: "Rice（Live2D 官方样例）",
    directory: "Rice",
    settingsFile: "Rice.model3.json",
    origin: "official-sample",
    temperamentSeed: {
      label: "认真慢热",
      summary: "对事情较认真，熟悉之后才会逐渐显露轻松的一面。",
      warmth: 0.58, curiosity: 0.49, playfulness: 0.27,
      directness: 0.65, initiative: 0.4, expressiveness: 0.42,
    },
  },
  {
    id: "cyannyan",
    name: "Cyannyan（CC BY-SA 4.0）",
    directory: "Cyannyan",
    settingsFile: "CyanSD.model3.json",
    origin: "third-party",
    temperamentSeed: {
      label: "俏皮机敏",
      summary: "对新东西反应很快，喜欢用鲜明表情和一点俏皮感参与对话。",
      warmth: 0.65, curiosity: 0.8, playfulness: 0.86,
      directness: 0.6, initiative: 0.66, expressiveness: 0.84,
    },
  },
  {
    id: "xiaoyun",
    name: "小云（CC BY-NC-SA 4.0）",
    directory: "Xiaoyun",
    settingsFile: "小云.model3.json",
    origin: "third-party",
    temperamentSeed: {
      label: "软萌主动",
      summary: "更自然地表达亲近和关心，也愿意主动给出轻量陪伴。",
      warmth: 0.81, curiosity: 0.7, playfulness: 0.75,
      directness: 0.45, initiative: 0.69, expressiveness: 0.73,
    },
  },
] as const satisfies readonly BundledModelDefinition[];
