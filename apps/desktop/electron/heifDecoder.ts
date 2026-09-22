// HEIF/HEIC 解码:在当前线程内加载 libheif-js 的 wasm bundle(libheif-wasm/
// libheif-bundle.js,wasm 以 base64 内嵌,require 即用,无需额外资源文件)。
// sharp 预编译的 libvips 不含 HEVC 解码器(libde265),解不了 HEIC/相机 HIF;
// 这里由 libheif 解出 RGBA8,再交给 sharp 缩放/编码。经内存缓冲区读取对个别
// 声明长度略超文件尾的相机 HIF(Windows 看图可正常打开)也比文件源更宽容。
// 调用方(缩略图 worker / 查看派生 worker)本身就是专用线程,阻塞无害。

interface HeifDisplayResult {
  data: Uint8Array;
  width: number;
  height: number;
}

interface HeifLibImage {
  get_width(): number;
  get_height(): number;
  /** 回调式异步解码:像素按容器内 irot/imir 变换定向后以 RGBA8 交错输出。 */
  display(target: HeifDisplayResult, cb: (result: HeifDisplayResult | null) => void): void;
  free(): void;
}

interface HeifLibModule {
  HeifDecoder: new () => { decode(data: Uint8Array | Buffer): HeifLibImage[] };
}

export interface HeifPixels {
  width: number;
  height: number;
  /** RGBA8 交错像素,已按容器方向标记定向。 */
  rgba: Uint8Array;
}

let libPromise: Promise<HeifLibModule> | null = null;

function loadHeifLib(): Promise<HeifLibModule> {
  libPromise ??= Promise.resolve(require('libheif-js/wasm-bundle.js') as HeifLibModule);
  return libPromise;
}

/**
 * 完整解码 HEIF/HEIC 主图为 RGBA8。速度参考:25MP 约 2s(wasm 单线程);
 * 多图/动图容器取首帧。失败(容器损坏、无 HEVC 数据)直接抛错给调用方。
 */
export async function decodeHeifToRgba(bytes: Uint8Array): Promise<HeifPixels> {
  const lib = await loadHeifLib();
  const images = new lib.HeifDecoder().decode(bytes);
  if (!images.length) throw new Error('HEIF 容器解析失败');
  const image = images[0];
  try {
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) throw new Error('无法读取 HEIF 尺寸');
    const result = await new Promise<HeifDisplayResult>((resolve, reject) => {
      image.display({ data: new Uint8Array(width * height * 4), width, height }, (r) => {
        if (r) resolve(r);
        else reject(new Error('HEIF 解码失败'));
      });
    });
    return { width: result.width, height: result.height, rgba: result.data };
  } finally {
    image.free();
  }
}
