package com.kanitsu.viewer.kanitsu;

import android.content.Context;
import android.net.Uri;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Streams a library folder into a user-chosen SAF zip document. */
public final class ZipExportService {
    // 与 SafSource.IMAGE_EXT 保持一致:普通图片 + 主流相机 RAW(原样打包)。
    private static final Set<String> IMAGE_EXT = new HashSet<>(Arrays.asList(
            "jpg", "jpe", "jpeg", "png", "webp", "avif", "bmp", "gif",
            "cr2", "cr3", "nef", "nrw", "arw", "dng", "raf", "orf", "rw2", "pef", "srw"));

    private final Context context;

    public ZipExportService(Context context) {
        this.context = context;
    }

    public int[] export(AlbumLibrary albums, String targetRelPath, Uri outUri, ProgressEmitter emitter, AtomicBoolean cancel) throws IOException, JSONException {
        File root = albums.ensureRoot();
        String norm = normalize(targetRelPath);
        File sourceDir = norm.isEmpty() ? root : new File(root, norm);
        albums.assertInside(sourceDir);
        String indexRoot = norm.isEmpty() ? "" : baseName(norm);

        List<Item> items = new ArrayList<>();
        collectItems(sourceDir, root, albums, items);
        items.sort((a, b) -> a.relPath.compareTo(b.relPath));

        int total = items.size();
        int[] counts = { total, 0 };

        OutputStream raw = context.getContentResolver().openOutputStream(outUri);
        if (raw == null) {
            throw new IOException("无法打开导出目标文件");
        }
        try (ZipOutputStream zos = new ZipOutputStream(raw)) {
            zos.setLevel(0); // STORE
            for (Item item : items) {
                // 取消检查：立即停止写入，已写入的条目保留。
                if (cancel != null && cancel.get()) {
                    break;
                }
                writeEntry(zos, item);
                counts[1]++;
                emitter.emit(counts[1], total, 0, item.relPath);
            }
            if (counts[1] > 0) {
                writeIndexJson(zos, indexRoot, items);
            }
            zos.finish();
        }
        return counts;
    }

    private void collectItems(File dir, File root, AlbumLibrary albums, List<Item> out) throws IOException {
        for (AndroidEntry child : albums.listChildren(dir)) {
            File f = new File(child.id);
            if (child.kind.equals("folder")) {
                collectItems(f, root, albums, out);
            } else if (IMAGE_EXT.contains(AlbumLibrary.extOf(child.name))) {
                out.add(new Item(albums.relPathOf(f), f, child.size, child.mtime, AlbumLibrary.extOf(child.name)));
            }
        }
    }

    private void writeEntry(ZipOutputStream zos, Item item) throws IOException {
        ZipEntry entry = new ZipEntry(item.relPath);
        zos.putNextEntry(entry);
        try (FileInputStream in = new FileInputStream(item.file)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) >= 0) {
                zos.write(buf, 0, n);
            }
        }
        zos.closeEntry();
    }

    private void writeIndexJson(ZipOutputStream zos, String indexRoot, List<Item> items) throws IOException, JSONException {
        JSONArray imagesArr = new JSONArray();
        for (Item item : items) {
            JSONObject o = new JSONObject();
            o.put("relPath", item.relPath);
            o.put("name", baseName(item.relPath));
            o.put("size", item.size);
            o.put("mtime", item.mtime);
            o.put("ext", item.ext);
            imagesArr.put(o);
        }

        Set<String> folderSet = new HashSet<>();
        for (Item item : items) {
            String p = parentRel(item.relPath);
            while (!p.isEmpty() && !folderSet.contains(p)) {
                folderSet.add(p);
                p = parentRel(p);
            }
        }

        List<String> folderList = new ArrayList<>(folderSet);
        java.util.Collections.sort(folderList);
        JSONArray foldersArr = new JSONArray();
        for (String relPath : folderList) {
            JSONObject o = new JSONObject();
            o.put("relPath", relPath);
            o.put("name", baseName(relPath));
            int direct = 0;
            int imageCount = 0;
            int childCount = 0;
            for (Item item : items) {
                if (parentRel(item.relPath).equals(relPath)) {
                    direct++;
                }
                if (item.relPath.startsWith(relPath + "/")) {
                    imageCount++;
                }
            }
            for (String cur : folderList) {
                if (parentRel(cur).equals(relPath)) {
                    childCount++;
                }
            }
            o.put("directImageCount", direct);
            o.put("imageCount", imageCount);
            o.put("childCount", childCount);
            foldersArr.put(o);
        }

        JSONObject index = new JSONObject();
        index.put("version", 1);
        index.put("exportedAt", System.currentTimeMillis());
        index.put("root", indexRoot);
        index.put("folders", foldersArr);
        index.put("images", imagesArr);

        ZipEntry entry = new ZipEntry("index.json");
        zos.putNextEntry(entry);
        zos.write(index.toString().getBytes(StandardCharsets.UTF_8));
        zos.closeEntry();
    }

    private static String normalize(String relPath) {
        String p = relPath == null ? "" : relPath.replace('\\', '/').replaceAll("^/+|/+$", "");
        return p;
    }

    private static String baseName(String relPath) {
        int i = relPath.lastIndexOf('/');
        return i < 0 ? relPath : relPath.substring(i + 1);
    }

    private static String parentRel(String relPath) {
        int i = relPath.lastIndexOf('/');
        return i < 0 ? "" : relPath.substring(0, i);
    }

    private static final class Item {
        final String relPath;
        final File file;
        final long size;
        final long mtime;
        final String ext;

        Item(String relPath, File file, long size, long mtime, String ext) {
            this.relPath = relPath;
            this.file = file;
            this.size = size;
            this.mtime = mtime;
            this.ext = ext;
        }
    }
}
