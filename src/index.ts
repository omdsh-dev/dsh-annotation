// dsh-annotation 的 Node half：浏览器端插件，Node 侧为空实现。
// 真实功能在 client.js（浏览器 bundle），经 dsh.client 声明接入 dsh web。
// 这里是干净构建入口 src/index.ts → lib/index.js（tsc，零运行时依赖）。

export const name = 'dsh-annotation'

export function apply(): void {}

export default { name, apply }
