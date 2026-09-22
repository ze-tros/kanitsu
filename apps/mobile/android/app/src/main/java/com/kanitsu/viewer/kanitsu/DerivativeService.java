package com.kanitsu.viewer.kanitsu;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.media.ExifInterface;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;

/**
 * HEIF/HEIC 全图查看派生:原生解码为 JPEG 落盘缓存。
 * WebView(Chromium)解不了 HEVC 编码的 HEIF,查看器改用本服务换取
 * 解码后的 JPEG,再经 _capacitor_file_ 流式给 <img>。缩略图不经此服务
 * (ThumbnailService 的 ImageDecoder 原生支持 HEIF)。
 * 单路串行:全尺寸位图内存大(25MP ARGB ≈ 100MB),并发只会挤爆堆。
 */
public final class DerivativeService {
    public static final int MAX_CACHE_BYTES = 1024 * 1024 * 1024;
    /** 派生图长边上限:与移动端 RAW 查看管线的 maxDim 对齐,覆盖 100% 查看。 */
    public static final int MAX_DIM = 6000;

    private final File cacheDir;
    private final Map<String, Object> locks = new ConcurrentHashMap<>();
    private final Semaphore decodeSlot = new Semaphore(1);

    public DerivativeService(Context context) {
        File base = context.getExternalFilesDir(null);
        if (base == null) {
            base = context.getCacheDir();
        }
        this.cacheDir = new File(base, "cache/derivatives");
        this.cacheDir.mkdirs();
    }

    /** 确保源文件的派生 JPEG 存在并返回该文件;失败抛 IOException。 */
    public File getOrCreate(File file) throws IOException {
        String key = keyOf(file);
        File out = new File(cacheDir, key + ".jpg");
        if (isUsable(out)) {
            return out;
        }
        Object lock = locks.computeIfAbsent(key, k -> new Object());
        synchronized (lock) {
            if (isUsable(out)) {
                // 触碰 mtime,让 LRU 清理按「最近使用」而非「最近生成」淘汰。
                out.setLastModified(System.currentTimeMillis());
                return out;
            }
            decodeSlot.acquireUninterruptibly();
            try {
                Bitmap bmp = decodeFull(file);
                if (bmp == null) {
                    throw new IOException("HEIF 解码失败: " + file.getName());
                }
                File tmp = new File(cacheDir, key + ".tmp");
                try (FileOutputStream fos = new FileOutputStream(tmp)) {
                    if (!bmp.compress(Bitmap.CompressFormat.JPEG, 90, fos)) {
                        tmp.delete();
                        throw new IOException("JPEG 编码失败: " + file.getName());
                    }
                }
                if (!tmp.renameTo(out)) {
                    tmp.delete();
                    throw new IOException("派生图写入失败: " + file.getName());
                }
                bmp.recycle();
                pruneIfNeeded();
                return out;
            } finally {
                decodeSlot.release();
                locks.remove(key);
            }
        }
    }

    public void clear() {
        File[] files = cacheDir.listFiles();
        if (files == null) {
            return;
        }
        for (File f : files) {
            f.delete();
        }
    }

    private static boolean isUsable(File f) {
        return f.exists() && f.length() > 0;
    }

    private Bitmap decodeFull(File file) {
        boolean fallback = false;
        Bitmap bmp;
        try {
            ImageDecoder.Source source = ImageDecoder.createSource(file);
            // ImageDecoder 默认应用 HEIF 容器方向(irot/imir)与 EXIF 方向;
            // 超限长边先用 setTargetSampleSize 整数降采样控内存,再精确缩放。
            bmp = ImageDecoder.decodeBitmap(source, (decoder, info, s) -> {
                int maxDim = Math.max(info.getSize().getWidth(), info.getSize().getHeight());
                if (maxDim > MAX_DIM) {
                    decoder.setTargetSampleSize(Math.max(1, maxDim / MAX_DIM));
                }
            });
        } catch (Throwable t) {
            fallback = true;
            bmp = decodeWithBitmapFactory(file);
        }
        if (bmp == null) {
            return null;
        }
        // BitmapFactory 回退路径不应用方向标记,补旋转(ImageDecoder 主路径勿重复)。
        if (fallback) {
            bmp = applyExifRotation(file, bmp);
        }
        int maxDim = Math.max(bmp.getWidth(), bmp.getHeight());
        if (maxDim > MAX_DIM) {
            float scale = (float) MAX_DIM / maxDim;
            Bitmap scaled = Bitmap.createScaledBitmap(
                    bmp,
                    Math.max(1, Math.round(bmp.getWidth() * scale)),
                    Math.max(1, Math.round(bmp.getHeight() * scale)),
                    true);
            if (scaled != bmp) {
                bmp.recycle();
            }
            bmp = scaled;
        }
        return bmp;
    }

    private Bitmap decodeWithBitmapFactory(File file) {
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
        if (opts.outWidth <= 0 || opts.outHeight <= 0) {
            return null;
        }
        BitmapFactory.Options decode = new BitmapFactory.Options();
        decode.inPreferredConfig = Bitmap.Config.ARGB_8888;
        return BitmapFactory.decodeFile(file.getAbsolutePath(), decode);
    }

    /** BitmapFactory 回退后的 EXIF 方向补偿(仅纯旋转;镜像组合的 5/8 按 270/90 处理)。 */
    private Bitmap applyExifRotation(File file, Bitmap bmp) {
        try {
            ExifInterface exif = new ExifInterface(file.getAbsolutePath());
            int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            float deg;
            switch (orientation) {
                case ExifInterface.ORIENTATION_ROTATE_90:
                case ExifInterface.ORIENTATION_TRANSPOSE:
                    deg = 90f;
                    break;
                case ExifInterface.ORIENTATION_ROTATE_180:
                    deg = 180f;
                    break;
                case ExifInterface.ORIENTATION_ROTATE_270:
                case ExifInterface.ORIENTATION_TRANSVERSE:
                    deg = 270f;
                    break;
                default:
                    return bmp;
            }
            Matrix m = new Matrix();
            m.postRotate(deg);
            Bitmap rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            if (rotated != bmp) {
                bmp.recycle();
            }
            return rotated;
        } catch (Throwable t) {
            return bmp;
        }
    }

    private static String keyOf(File file) {
        return AlbumLibrary.sha1(file.getAbsolutePath() + "|" + file.lastModified() + "|" + file.length() + "|v1");
    }

    private void pruneIfNeeded() {
        File[] files = cacheDir.listFiles();
        if (files == null) {
            return;
        }
        long total = 0;
        for (File f : files) {
            total += f.length();
        }
        if (total <= MAX_CACHE_BYTES) {
            return;
        }
        List<File> list = new ArrayList<>();
        for (File f : files) {
            list.add(f);
        }
        list.sort((a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : list) {
            if (total <= MAX_CACHE_BYTES * 4 / 5) {
                break;
            }
            long len = f.length();
            if (f.delete()) {
                total -= len;
            }
        }
    }
}
