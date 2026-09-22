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
  /** emscripten 侧的 heif_image_handle 对象(枚举内嵌 item 时使用)。 */
  handle: unknown;
  get_width(): number;
  get_height(): number;
  /** 回调式异步解码:像素按容器内 irot/imir 变换定向后以 RGBA8 交错输出。 */
  display(target: HeifDisplayResult, cb: (result: HeifDisplayResult | null) => void): void;
  free(): void;
}

interface HeifLibModule {
  HeifDecoder: new () => {
    decode(data: Uint8Array | Buffer): HeifLibImage[];
    /** emscripten 侧的 heif_context 对象(枚举内嵌 item 时使用)。 */
    decoder?: unknown;
  };
  heif_context_get_list_of_item_IDs(ctx: unknown): number[];
  heif_item_is_item_hidden(ctx: unknown, id: number): boolean | number;
  heif_context_get_image_handle(ctx: unknown, id: number): unknown;
  heif_image_handle_release(handle: unknown): void;
  heif_image_handle_is_primary_image(handle: unknown): boolean | number;
  heif_image_handle_get_width(handle: unknown): number;
  heif_image_handle_get_height(handle: unknown): number;
  heif_js_decode_image2(
    handle: unknown,
    colorspace: unknown,
    chroma: unknown,
  ): Promise<{ code?: unknown; image?: unknown; channels?: { id: unknown; width: number; height: number; stride: number; data: Uint8Array }[] }>;
  heif_image_release(image: unknown): void;
  heif_colorspace: { heif_colorspace_RGB: unknown };
  heif_chroma: { heif_chroma_interleaved_RGBA: unknown };
  heif_channel: { heif_channel_interleaved: unknown };
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

/** 从 RGBA 交错解码结果里取出像素(处理行跨度对齐)。 */
function extractInterleaved(lib: HeifLibModule, out: NonNullable<Awaited<ReturnType<HeifLibModule['heif_js_decode_image2']>>>): HeifPixels {
  if (!out.channels) throw new Error('HEIF 解码无像素输出');
  for (const channel of out.channels) {
    if (channel.id === lib.heif_channel.heif_channel_interleaved) {
      const { width, height, stride, data } = channel;
      if (stride === width * 4) {
        return { width, height, rgba: data };
      }
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        rgba.set(data.subarray(y * stride, y * stride + width * 4), y * width * 4);
      }
      return { width, height, rgba };
    }
  }
  throw new Error('HEIF 解码缺少 RGBA 通道');
}

/**
 * 解码容器内嵌的缩略图/预览 item 为 RGBA8(用于网格缩略图加速,毫秒级),
 * 找不到满足清晰度下限的 item、或 item 解码失败时返回 null,由调用方回退
 * 主图完整解码。
 *
 * 只考虑非隐藏的独立图像 item(必须跳过隐藏 item:相机 HEIF 的主图常由
 * 隐藏网格分块拼成,单独解码分块只会得到四分之一画面);部分相机(如 Sony)
 * 的内嵌 item 实际编码尺寸与 ispe 声明不一致,会被 libheif 的安全校验拒绝,
 * 此时对候选逐个尝试、全部失败即回退,代价仅几十毫秒的失败尝试。
 *
 * @param minLongEdge 候选长边下限(清晰度下限,防止小图放大发糊)。
 */
export async function decodeHeifEmbeddedToRgba(bytes: Uint8Array, minLongEdge: number): Promise<HeifPixels | null> {
  const lib = await loadHeifLib();
  const dec = new lib.HeifDecoder();
  const images = dec.decode(bytes);
  if (!images.length) return null;
  const ctx = dec.decoder;
  if (!ctx) return null;

  // 收集候选:主图之外的顶层图像(部分文件把预览列为顶层图像)+ 独立图像 item。
  // 主图排除用 is_primary_image 标记( get_item_id 绑定不可靠,不能按 id 比)。
  const candidates: { handle: unknown; long: number; area: number }[] = [];
  for (let i = 1; i < images.length; i++) {
    try {
      const handle = images[i].handle;
      if (lib.heif_image_handle_is_primary_image(handle)) continue;
      const long = Math.max(images[i].get_width(), images[i].get_height());
      if (long > 0) candidates.push({ handle, long, area: long * Math.min(images[i].get_width(), images[i].get_height()) });
    } catch {
      // 跳过异常的顶层图像
    }
  }
  try {
    for (const id of lib.heif_context_get_list_of_item_IDs(ctx)) {
      if (lib.heif_item_is_item_hidden(ctx, id)) continue;
      let handle: unknown;
      try {
        handle = lib.heif_context_get_image_handle(ctx, id);
      } catch {
        continue; // 非图像 item(Exif/mime 等)取句柄会抛错
      }
      try {
        if (lib.heif_image_handle_is_primary_image(handle)) continue;
      } catch {
        // 标记不可用时保留候选:后面还有隐藏过滤与尺寸下限兜底
      }
      const width = lib.heif_image_handle_get_width(handle);
      const height = lib.heif_image_handle_get_height(handle);
      if (width > 0 && height > 0) {
        candidates.push({ handle, long: Math.max(width, height), area: width * height });
      } else {
        lib.heif_image_handle_release(handle);
      }
    }
  } catch {
    // 枚举失败不影响候选解析
  }

  // 满足清晰度下限的候选里取像素量最小者(解码最快),逐个尝试直至成功。
  const acceptable = candidates
    .filter((c) => c.long >= minLongEdge)
    .sort((a, b) => a.area - b.area);
  let pixels: HeifPixels | null = null;
  for (const candidate of acceptable) {
    try {
      const out = await lib.heif_js_decode_image2(
        candidate.handle,
        lib.heif_colorspace.heif_colorspace_RGB,
        lib.heif_chroma.heif_chroma_interleaved_RGBA,
      );
      if (out && out.image && out.channels) {
        try {
          pixels = extractInterleaved(lib, out);
        } finally {
          lib.heif_image_release(out.image);
        }
        break;
      }
    } catch {
      // 该 item 解码失败(ispe 不一致等),换下一个候选
    }
  }
  for (const candidate of candidates) {
    try {
      lib.heif_image_handle_release(candidate.handle);
    } catch {
      // 释放失败忽略
    }
  }
  return pixels;
}
