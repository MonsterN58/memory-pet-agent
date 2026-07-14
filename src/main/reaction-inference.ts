import type { PetEmotion } from "../common/types";

const DISTRESS = /难过|伤心|焦虑|压力|崩溃|痛苦|害怕|孤独|委屈|累坏|撑不住/;
const SUPPORT = /陪|慢慢来|别急|没关系|我在|抱抱|理解|辛苦|不必.*解决/;

export function inferReaction(userText: string, responseText: string): PetEmotion {
  const user = userText.trim();
  const response = responseText.trim();
  const combined = `${user}\n${response}`;

  if (DISTRESS.test(user) && SUPPORT.test(response)) return "comforting";
  if (/居然|竟然|意外|没想到|不可思议|吓一跳|真的吗[？！?!]/.test(combined)) return "surprised";
  if (/太棒|好耶|激动|成功啦|终于.{0,8}(成功|完成|跑起来)|[！!]{2,}/.test(combined)) return "excited";
  if (/害羞|不好意思|脸红|被你.{0,8}夸/.test(combined)) return "shy";
  if (/困了?|想睡|晚安|早点休息|睡觉|打哈欠/.test(combined)) return "sleepy";
  if (/想一想|分析|考虑|思考|先拆|推理|琢磨/.test(response)) return "thinking";
  if (/为什么|怎么|如何|什么|好奇|想知道|进展|吗[？?]|呢[？?]/.test(response)) return "curious";
  if (/开心|高兴|真好|不错|喜欢|欢迎|你好|哈哈|😊|☺/.test(combined)) return "happy";
  return "idle";
}
