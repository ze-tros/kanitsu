/**
 * RAW 解码会话(浏览器/WebView 环境)。
 *
 * 每个会话对应一个自管 Worker 实例(见 browser/client.ts),解码不阻塞
 * UI 线程;用完必须 close() 终止 Worker 并释放 wasm 堆内存。
 * 会话的解码设置(白平衡/色域/halfSize)在 open 时固定,不同设置需重开会话。
 */

export interface RawPreview {
  kind: 'jpeg' | 'rgb';
  data: Uint8Array;
  width: number;
  height: number;
  /**
   * rgb 位图预览无 EXIF 方向标记:按 LibRaw flip 换算的顺时针旋转角
   * (0/90/180/270),编码为 JPEG 前需旋转。jpeg 预览自带 EXIF,恒为 0
   * (消费方需保留 EXIF 直通,或重编码时按 EXIF 自动定向)。
   */
  rotateDeg: number;
}

/** 完整解码结果:RGB8(已含白平衡/色域/旋转处理)。 */
export interface RawPixels {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RawSession {
  /** 提取相机内嵌预览;无内嵌预览(部分 DNG/老机型)返回 null。 */
  thumbnail(): Promise<RawPreview | null>;
  /** 完整解码(demosaic + 白平衡 + sRGB),像素已按相机方向旋转。 */
  pixels(): Promise<RawPixels>;
  close(): void;
}
