package com.kanitu.viewer.kanitu;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ImageDecoder;
import android.graphics.Movie;
import com.squareup.gifencoder.GifEncoder;
import com.squareup.gifencoder.ImageOptions;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Native thumbnail generation + disk cache. */
public final class ThumbnailService {
    public static final int MAX_CACHE_BYTES = 512 * 1024 * 1024;
    public static final int GIF_PASSTHROUGH_BYTES = 256 * 1024;
    /** 超过该字节数的 GIF 不做「整读 + 动画缩略图」，只取静态首帧：避免把数 MB
     *  源文件整体读进堆内存。快速滚动并发下大 GIF 整读正是 OOM 的主要来源。 */
    public static final int MAX_ANIMATED_GIF_BYTES = 4 * 1024 * 1024;
    /** 同时进行内存密集型解码/编码的通道数。快速滑动 + 各级预取会同时触发大量
     *  缩略图生成，每路都持有解码位图与编码缓冲；无界并发会瞬间打爆 256MB 堆
     *  （OOM 闪退）。固定 2 路：一屏内缩略图仍足够快，且内存安全。 */
    private static final int MAX_CONCURRENT_DECODES = 2;

    private final File cacheDir;
    private final Map<String, Object> locks = new ConcurrentHashMap<>();
    private final Semaphore decodeSlots = new Semaphore(MAX_CONCURRENT_DECODES);
    private final AtomicInteger inFlight = new AtomicInteger(0);

    public ThumbnailService(Context context) {
        File base = context.getExternalFilesDir(null);
        if (base == null) {
            base = context.getCacheDir();
        }
        this.cacheDir = new File(base, "cache/thumbcache");
        this.cacheDir.mkdirs();
    }

    public static final class Result {
        public final byte[] data;
        public final String mime;

        Result(byte[] data, String mime) {
            this.data = data;
            this.mime = mime;
        }
    }

    public Result getOrCreate(File file, int maxSize, int priority) {
        String key = keyOf(file, maxSize);
        Result cached = lookup(key);
        if (cached != null) {
            return cached;
        }

        Object lock = locks.computeIfAbsent(key, k -> new Object());
        synchronized (lock) {
            cached = lookup(key);
            if (cached != null) {
                return cached;
            }
            inFlight.incrementAndGet();
            try {
                Result generated = generate(file, maxSize);
                store(key, generated);
                pruneIfNeeded();
                return generated;
            } finally {
                inFlight.decrementAndGet();
                locks.remove(key);
            }
        }
    }

    public void clear() {
        File[] files = cacheDir.listFiles();
        if (files != null) {
            for (File f : files) {
                f.delete();
            }
        }
    }

    public int[] queuedByPriority() {
        // Synchronous generation is used for now; the four buckets remain reserved
        // for a future priority executor (visible/current/subfolder/warmup).
        return new int[] { 0, 0, 0, 0 };
    }

    public int inFlight() {
        return inFlight.get();
    }

    public int diskFiles() {
        File[] files = cacheDir.listFiles();
        return files == null ? 0 : files.length;
    }

    public long diskBytes() {
        File[] files = cacheDir.listFiles();
        long total = 0;
        if (files != null) {
            for (File f : files) {
                total += f.length();
            }
        }
        return total;
    }

    private Result lookup(String key) {
        File gif = new File(cacheDir, key + ".gif");
        if (gif.exists()) {
            return new Result(readFile(gif), "image/gif");
        }
        File jpg = new File(cacheDir, key + ".jpg");
        if (jpg.exists()) {
            return new Result(readFile(jpg), "image/jpeg");
        }
        return null;
    }

    private void store(String key, Result result) {
        String suffix = "image/gif".equals(result.mime) ? ".gif" : ".jpg";
        File out = new File(cacheDir, key + suffix);
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(result.data);
        } catch (IOException ignored) {
        }
    }

    private Result generate(File file, int maxSize) {
        // 解码/编码是内存密集段：用信号量把同时进行的生成收口到常数，防止
        // 快速滚动时可见卡片 + 预取同时触发几十路生成把 256MB 堆打爆。
        decodeSlots.acquireUninterruptibly();
        try {
            return doGenerate(file, maxSize);
        } finally {
            decodeSlots.release();
        }
    }

    private Result doGenerate(File file, int maxSize) {
        String ext = AlbumLibrary.extOf(file.getName());
        if ("gif".equals(ext)) {
            long len = file.length();
            // 先看文件大小再决定是否整读（原来先整读后判断，数 MB 的 GIF 会先占
            // 满内存才被拒，并发下正是 OOM 来源）：
            //   ≤256KB  原样透传（动画完美且小）；
            //   256KB~4MB 抽帧做「可动且小」的动画缩略图；
            //   >4MB    只取静态首帧，绝不整读到内存。
            if (len > 0 && len <= GIF_PASSTHROUGH_BYTES) {
                byte[] raw = readFile(file);
                if (raw != null) {
                    return new Result(raw, "image/gif");
                }
            } else if (len <= MAX_ANIMATED_GIF_BYTES) {
                byte[] raw = readFile(file);
                byte[] animated = tryAnimatedGif(raw, maxSize);
                if (animated != null) {
                    return new Result(animated, "image/gif");
                }
            }
        }

        Bitmap bmp = decodeBitmap(file, maxSize);
        if (bmp == null) {
            return new Result(new byte[0], "image/jpeg");
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 80, bos);
        bmp.recycle();
        return new Result(bos.toByteArray(), "image/jpeg");
    }

    private Bitmap decodeBitmap(File file, int maxSize) {
        Bitmap bmp = null;
        try {
            ImageDecoder.Source source = ImageDecoder.createSource(file);
            bmp = ImageDecoder.decodeBitmap(source, (decoder, info, s) -> {
                int w = info.getSize().getWidth();
                int h = info.getSize().getHeight();
                int maxDim = Math.max(w, h);
                if (maxDim > maxSize) {
                    decoder.setTargetSampleSize(Math.max(1, maxDim / maxSize));
                }
            });
        } catch (Throwable t) {
            bmp = decodeWithBitmapFactory(file, maxSize);
        }
        if (bmp == null) {
            return null;
        }
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        int maxDim = Math.max(w, h);
        if (maxDim > maxSize) {
            float scale = (float) maxSize / maxDim;
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), true);
            if (scaled != bmp) {
                bmp.recycle();
            }
            bmp = scaled;
        }
        return bmp;
    }

    private Bitmap decodeWithBitmapFactory(File file, int maxSize) {
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
        int w = opts.outWidth;
        int h = opts.outHeight;
        if (w <= 0 || h <= 0) {
            return null;
        }
        int sample = 1;
        while (Math.max(w, h) / (sample * 2) >= maxSize) {
            sample *= 2;
        }
        opts.inJustDecodeBounds = false;
        opts.inSampleSize = sample;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        return BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
    }

    private byte[] tryAnimatedGif(byte[] raw, int maxSize) {
        try {
            InputStream in = new ByteArrayInputStream(raw);
            Movie movie = Movie.decodeStream(in);
            if (movie == null) {
                return null;
            }
            int duration = movie.duration();
            int w = movie.width();
            int h = movie.height();
            if (duration <= 0 || w <= 0 || h <= 0) {
                return null;
            }
            float scale = Math.min(1f, Math.min((float) maxSize / w, (float) maxSize / h));
            int tw = Math.max(1, Math.round(w * scale));
            int th = Math.max(1, Math.round(h * scale));
            int frameCount = Math.min(16, Math.max(2, Math.round(duration / 100f)));
            int delayMs = Math.max(20, Math.round((float) duration / frameCount));

            List<int[]> frames = new ArrayList<>();
            for (int i = 0; i < frameCount; i++) {
                int t = Math.min(duration - 1, (int) ((long) duration * i / frameCount));
                movie.setTime(t);
                Bitmap frame = Bitmap.createBitmap(tw, th, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(frame);
                canvas.scale(scale, scale);
                movie.draw(canvas, 0, 0);
                int[] pixels = new int[tw * th];
                frame.getPixels(pixels, 0, tw, 0, 0, tw, th);
                frames.add(pixels);
                frame.recycle();
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            GifEncoder encoder = new GifEncoder(out, tw, th, 0);
            for (int[] px : frames) {
                ImageOptions options = new ImageOptions().setDelay(delayMs, TimeUnit.MILLISECONDS);
                encoder.addImage(px, tw, options);
            }
            encoder.finishEncoding();
            return out.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }

    private static String keyOf(File file, int maxSize) {
        return AlbumLibrary.sha1(file.getAbsolutePath() + "|" + file.lastModified() + "|" + file.length() + "|" + maxSize + "|v1");
    }

    private static byte[] readFile(File file) {
        try (FileInputStream in = new FileInputStream(file)) {
            return AlbumLibrary.readAll(in);
        } catch (IOException e) {
            return null;
        }
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
