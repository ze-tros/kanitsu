package com.kanitsu.viewer.kanitsu;

import android.content.Context;
import android.webkit.MimeTypeMap;
import java.io.ByteArrayOutputStream;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Manages the app-owned album library under getExternalFilesDir(null)/albums. */
public final class AlbumLibrary {
    public static final String ROOT_DIR = "albums";

    private final File root;

    public AlbumLibrary(Context context) {
        this.root = new File(context.getExternalFilesDir(null), ROOT_DIR);
    }

    public File ensureRoot() {
        if (!root.exists()) {
            root.mkdirs();
        }
        return root;
    }

    public AndroidEntry rootEntry() {
        ensureRoot();
        return AndroidEntry.folder(root.getAbsolutePath(), "全部相册");
    }

    public File fileForId(String id) {
        return new File(id);
    }

    public void assertInside(File f) throws IOException {
        String rootPath = root.getCanonicalPath();
        String filePath = f.getCanonicalPath();
        if (!filePath.equals(rootPath) && !filePath.startsWith(rootPath + File.separator)) {
            throw new IOException("路径越界：" + filePath);
        }
    }

    public AndroidEntry createFolder(File parent, String name) throws IOException {
        assertInside(parent);
        File dir = new File(parent, sanitize(name));
        if (!dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("创建目录失败：" + name);
        }
        return AndroidEntry.folder(dir.getAbsolutePath(), dir.getName());
    }

    public AndroidEntry createUniqueTopFolder(String name) throws IOException {
        ensureRoot();
        String base = sanitize(name);
        File dir = new File(root, base);
        int i = 2;
        while (dir.exists()) {
            dir = new File(root, base + " (" + (i++) + ")");
        }
        if (!dir.mkdirs()) {
            throw new IOException("创建目录失败：" + dir.getName());
        }
        return AndroidEntry.folder(dir.getAbsolutePath(), dir.getName());
    }

    public AndroidEntry write(File dir, String name, byte[] data) throws IOException {
        assertInside(dir);
        File out = new File(dir, name);
        try (BufferedOutputStream fos = new BufferedOutputStream(new FileOutputStream(out), 256 * 1024)) {
            fos.write(data);
        }
        return AndroidEntry.file(out.getAbsolutePath(), name, data.length, out.lastModified(), 0, 0);
    }

    public AndroidEntry write(File dir, String name, InputStream input) throws IOException {
        assertInside(dir);
        File out = new File(dir, name);
        long bytes = 0;
        byte[] buffer = new byte[256 * 1024];
        try (BufferedInputStream in = new BufferedInputStream(input, buffer.length);
             BufferedOutputStream fos = new BufferedOutputStream(new FileOutputStream(out), buffer.length)) {
            int n;
            while ((n = in.read(buffer)) >= 0) {
                fos.write(buffer, 0, n);
                bytes += n;
            }
        }
        return AndroidEntry.file(out.getAbsolutePath(), name, bytes, out.lastModified(), 0, 0);
    }

    public List<AndroidEntry> listChildren(File dir) throws IOException {
        assertInside(dir);
        File[] children = dir.listFiles();
        List<AndroidEntry> out = new ArrayList<>();
        if (children == null) {
            return out;
        }
        for (File c : children) {
            if (c.isDirectory()) {
                out.add(AndroidEntry.folder(c.getAbsolutePath(), c.getName()));
            } else {
                out.add(AndroidEntry.file(c.getAbsolutePath(), c.getName(), c.length(), c.lastModified(), 0, 0));
            }
        }
        out.sort((a, b) -> {
            if (!a.kind.equals(b.kind)) {
                return a.kind.equals("folder") ? -1 : 1;
            }
            return a.name.compareToIgnoreCase(b.name);
        });
        return out;
    }

    public byte[] read(File file) throws IOException {
        assertInside(file);
        try (FileInputStream in = new FileInputStream(file)) {
            return readAll(in);
        }
    }

    public String mimeOf(File f) {
        // 主流 RAW:系统 MimeTypeMap 不认识,显式给 image/x-* 便于 JS 侧 Blob 标注。
        String raw = RAW_MIME.get(extOf(f.getName()));
        if (raw != null) {
            return raw;
        }
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extOf(f.getName()));
        return mime != null ? mime : "application/octet-stream";
    }

    private static final java.util.Map<String, String> RAW_MIME = new java.util.HashMap<>();
    static {
        RAW_MIME.put("cr2", "image/x-canon-cr2");
        RAW_MIME.put("cr3", "image/x-canon-cr3");
        RAW_MIME.put("nef", "image/x-nikon-nef");
        RAW_MIME.put("nrw", "image/x-nikon-nrw");
        RAW_MIME.put("arw", "image/x-sony-arw");
        RAW_MIME.put("dng", "image/x-adobe-dng");
        RAW_MIME.put("raf", "image/x-fuji-raf");
        RAW_MIME.put("orf", "image/x-olympus-orf");
        RAW_MIME.put("rw2", "image/x-panasonic-rw2");
        RAW_MIME.put("pef", "image/x-pentax-pef");
        RAW_MIME.put("srw", "image/x-samsung-srw");
    }

    public AndroidEntry move(File from, File toDir, String newName) throws IOException {
        assertInside(from);
        assertInside(toDir);
        String targetName = (newName == null || newName.trim().isEmpty()) ? from.getName() : sanitize(newName);
        File to = new File(toDir, targetName);
        if (to.exists()) {
            throw new IOException("目标已存在：" + targetName);
        }
        if (!from.renameTo(to)) {
            copyRecursive(from, to);
            deleteRecursive(from);
        }
        if (to.isDirectory()) {
            return AndroidEntry.folder(to.getAbsolutePath(), to.getName());
        }
        return AndroidEntry.file(to.getAbsolutePath(), to.getName(), to.length(), to.lastModified(), 0, 0);
    }

    public void remove(File f) throws IOException {
        assertInside(f);
        deleteRecursive(f);
    }

    public String fingerprint() {
        ensureRoot();
        File[] children = root.listFiles();
        List<String> parts = new ArrayList<>();
        if (children != null) {
            for (File c : children) {
                parts.add((c.isDirectory() ? "folder" : "file") + ":" + c.getName());
            }
        }
        return sha1(String.join("|", parts));
    }

    public String relPathOf(File f) throws IOException {
        assertInside(f);
        String rootPath = root.getCanonicalPath();
        String filePath = f.getCanonicalPath();
        if (filePath.equals(rootPath)) {
            return "";
        }
        return filePath.substring(rootPath.length() + 1).replace(File.separatorChar, '/');
    }

    public static String extOf(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    public static String sanitize(String name) {
        String n = name == null ? "" : name.trim();
        n = n.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (n.isEmpty()) {
            n = "未命名相册";
        }
        return n;
    }

    public static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) >= 0) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    public static String sha1(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format(Locale.ROOT, "%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(input.hashCode());
        }
    }

    private static void copyRecursive(File src, File dst) throws IOException {
        if (src.isDirectory()) {
            dst.mkdirs();
            File[] kids = src.listFiles();
            if (kids != null) {
                for (File k : kids) {
                    copyRecursive(k, new File(dst, k.getName()));
                }
            }
        } else {
            try (FileInputStream in = new FileInputStream(src); FileOutputStream out = new FileOutputStream(dst)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    out.write(buf, 0, n);
                }
            }
        }
    }

    private static void deleteRecursive(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) {
                for (File k : kids) {
                    deleteRecursive(k);
                }
            }
        }
        f.delete();
    }
}
