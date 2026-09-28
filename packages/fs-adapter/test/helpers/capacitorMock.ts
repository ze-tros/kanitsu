/**
 * @capacitor/core 的测试替身：androidBridge.test.ts 通过 esbuild
 * `--alias:@capacitor/core=./test/helpers/capacitorMock.ts` 把适配器里的动态
 * import 指到这里，使 initAndroidBridge 的真实桥接线（含 base64 编解码）被
 * 端到端执行，而不是从旁路 mock 掉桥对象本身。
 */

let plugin: unknown;

/** 注册 androidBridge.test 使用的插件级 mock（形态对齐 KanitsuPlugin.java）。 */
export function setPluginMock(mock: unknown): void {
  plugin = mock;
}

/** 与 @capacitor/core 同步签名一致（适配器不解包 Promise）。 */
export function registerPlugin<T>(): T {
  if (!plugin) throw new Error('测试未调用 setPluginMock()');
  return plugin as T;
}
