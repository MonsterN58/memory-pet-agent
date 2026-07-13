import { rmSync } from "node:fs";
import { resolve } from "node:path";

// 只清理可再生成的编译产物，避免旧目录结构被打进安装包。
rmSync(resolve("dist"), { recursive: true, force: true });
