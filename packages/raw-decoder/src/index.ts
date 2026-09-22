/**
 * RAW 解码共享包(浏览器/WebView 侧)。
 *
 * 依赖 libraw-wasm(emscripten 编译的 LibRaw):
 * - 缩略图/网格:提取相机内嵌全尺寸 JPEG 预览(毫秒级,零重编码直通);
 * - 查看器:完整解码(demosaic + 相机白平衡 + sRGB,秒级)。
 * 解码全部发生在自管 Worker 内(browser/),宿主 bundle 只含轻量胶水,
 * wasm(~1.4MB)仅在首次真正解码时经 fetch 加载。
 *
 * 格式白名单的规范来源在 core/path.ts;桌面主进程有一份独立维护的副本
 * (apps/desktop/electron/rawDecoder.ts,受 tsc rootDir 限制),两处需同步。
 */
export { RAW_IMAGE_EXT, isRawImage } from './formats';
export type { RawPreview, RawPixels, RawSession } from './decoder';
export { openBrowserRawSession } from './browser/client';
export {
  extractRawPreviewJpeg,
  decodeRawToJpeg,
  decodeRawThumbnailJpeg,
} from './convenience';
export { resolveRawDecodeOptions } from './options';
export type { RawDecodeOptions } from './options';
export { encodeRgbJpeg } from './encode';
