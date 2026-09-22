/** RAW 解码公共设置(与 libraw-wasm 的 LibRawSettings 子集对齐)。 */

export interface RawDecodeOptions {
  /**
   * 使用相机记录的白平衡(默认开):输出与机内 JPEG 观感一致,
   * 避免无白平衡处理的偏色。
   */
  useCameraWb?: boolean;
  /** 输出色域:1 = sRGB(libraw 的 outputColor 枚举)。 */
  outputColor?: number;
  /** 半尺寸解码:像素量降为 1/4,速度约快 4 倍,用于缩略图兜底与移动端。 */
  halfSize?: boolean;
}

export interface ResolvedRawDecodeOptions {
  useCameraWb: boolean;
  outputColor: number;
  halfSize: boolean;
}

export function resolveRawDecodeOptions(opts?: RawDecodeOptions): ResolvedRawDecodeOptions {
  return {
    useCameraWb: opts?.useCameraWb ?? true,
    outputColor: opts?.outputColor ?? 1,
    halfSize: opts?.halfSize ?? false,
  };
}

/** libraw-wasm `open()` 的完整设置(内嵌预览提取时只用默认管线,无需 demosaic 设置)。 */
export function toLibrawSettings(opts: ResolvedRawDecodeOptions): {
  useCameraWb: boolean;
  outputColor: number;
  outputBps: number;
  halfSize: boolean;
} {
  return {
    useCameraWb: opts.useCameraWb,
    outputColor: opts.outputColor,
    outputBps: 8,
    halfSize: opts.halfSize,
  };
}
