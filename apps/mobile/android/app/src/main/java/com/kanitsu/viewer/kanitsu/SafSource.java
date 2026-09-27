package com.kanitsu.viewer.kanitsu;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;

/** SAF (Storage Access Framework) source tree reader and native importer. */
public final class SafSource {
    // 普通图片 + 主流相机 RAW + HEIF/HEIC:RAW 原样拷贝入库,解码在 WebView 内完成
    // (libraw-wasm);HEIF 原生侧可直接解码(API 28+ ImageDecoder/BitmapFactory 原生
    // 支持 HEIF,缩略图走 ThumbnailService,全图查看经原生派生服务转 JPEG)。
    private static final Set<String> IMAGE_EXT = new HashSet<>(Arrays.asList(
            "jpg", "jpe", "jpeg", "png", "webp", "avif", "bmp", "gif",
            "cr2", "cr3", "nef", "nrw", "arw", "dng", "raf", "orf", "rw2", "pef", "srw",
            "heic", "heif", "hif"));

    private final Context context;
    private Uri treeUri;

    public SafSource(Context context) {
        this.context = context;
    }

    public void setTreeUri(Uri uri) {
        this.treeUri = uri;
    }

    public boolean hasTree() {
        return treeUri != null;
    }

    public String rootDocumentId() {
        return DocumentsContract.getTreeDocumentId(treeUri);
    }

    public String rootDisplayName() {
        return displayName(rootDocumentId());
    }

    private String displayName(String documentId) {
        try {
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
            try (Cursor c = context.getContentResolver().query(docUri, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    return c.getString(0);
                }
            }
        } catch (Exception ignored) {
        }
        return "已选文件夹";
    }

    public List<AndroidEntry> listChildren(String documentId) {
        return listChildren(documentId, null);
    }

    /**
     * 列出 SAF 目录的子项。行级异常只丢掉那一行并记入 errors（可选）：
     * 整个游标循环被 catch 吞掉时，无权限/提供方回收的目录会静默表现为
     * 「空图包」，导入静默少拷且不留任何痕迹。
     */
    public List<AndroidEntry> listChildren(String documentId, List<String> errors) {
        List<AndroidEntry> out = new ArrayList<>();
        Uri childrenUri;
        Cursor c = null;
        try {
            childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId);
            c = context.getContentResolver().query(childrenUri,
                new String[] {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
                }, null, null, null);
            while (c != null && c.moveToNext()) {
                try {
                    String id = c.getString(0);
                    String name = c.getString(1);
                    if (name == null || name.isEmpty()) {
                        name = "未命名";
                    }
                    String mime = c.getString(2);
                    long size = safeLong(c, 3);
                    long mtime = safeLong(c, 4);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        out.add(AndroidEntry.folder(id, name));
                    } else {
                        out.add(AndroidEntry.file(id, name, size, mtime, 0, 0));
                    }
                } catch (Exception rowError) {
                    if (errors != null) {
                        errors.add(documentId + " 行读取失败: " + String.valueOf(rowError.getMessage()));
                    }
                }
            }
        } catch (Exception queryError) {
            if (errors != null) {
                errors.add(documentId + " 目录查询失败: " + String.valueOf(queryError.getMessage()));
            }
        } finally {
            if (c != null) {
                try {
                    c.close();
                } catch (Exception ignored) {
                }
            }
        }
        // name 已经兜底为非空，这里再防一次历史数据（null 安全比较）。
        out.sort((a, b) -> a.kind.equals(b.kind)
                ? String.valueOf(a.name).compareToIgnoreCase(String.valueOf(b.name))
                : (a.kind.equals("folder") ? -1 : 1));
        return out;
    }

    public byte[] readBytes(String documentId) throws IOException {
        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
        try (InputStream in = context.getContentResolver().openInputStream(docUri)) {
            if (in == null) {
                throw new IOException("无法打开文件");
            }
            return AlbumLibrary.readAll(in);
        }
    }

    public String readBase64(String documentId) throws IOException {
        return Base64.encodeToString(readBytes(documentId), Base64.NO_WRAP);
    }

    public String mimeOfName(String name) {
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(AlbumLibrary.extOf(name));
        return mime != null ? mime : "application/octet-stream";
    }

    public void release() {
        if (treeUri != null) {
            try {
                context.getContentResolver().releasePersistableUriPermission(treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            treeUri = null;
        }
    }

    /** Native whole-tree copy: SAF source -> albums/<unique top folder>. */
    public JSObject importTree(String targetTopName, AlbumLibrary albums, ProgressEmitter emitter, AtomicBoolean cancel) throws IOException {
        albums.ensureRoot();
        AndroidEntry top = albums.createUniqueTopFolder(targetTopName);

        final int[] scanned = { 0 };
        final int[] copied = { 0 };
        final int[] skipped = { 0 };
        final List<JSObject> skippedFiles = new ArrayList<>();
        final List<String> errors = new ArrayList<>();

        walk(rootDocumentId(), new File(top.id), "", scanned, copied, skipped, skippedFiles, errors, albums, emitter, cancel);

        JSObject out = new JSObject();
        out.put("canceled", cancel != null && cancel.get());
        out.put("targetTopFolder", top.name);
        out.put("scannedFileCount", scanned[0]);
        out.put("copiedImageCount", copied[0]);
        out.put("skippedCount", skipped[0]);
        out.put("skippedFiles", new JSONArray(skippedFiles));
        out.put("errors", new JSONArray(errors));
        return out;
    }

    private void walk(String documentId, File dstDir, String relPath, int[] scanned, int[] copied, int[] skipped,
                      List<JSObject> skippedFiles, List<String> errors, AlbumLibrary albums, ProgressEmitter emitter, AtomicBoolean cancel) throws IOException {
        List<String> rowErrors = new ArrayList<>();
        List<AndroidEntry> children = listChildren(documentId, rowErrors);
        errors.addAll(rowErrors);
        for (AndroidEntry child : children) {
            // 取消检查：已复制文件保留，直接停止后续复制（下次重试按 size+mtime 跳过）。
            if (cancel != null && cancel.get()) {
                return;
            }
            // 应用私有名与桌面端导入口径一致：.kanitsu-cache / .kanitsu-library.json
            // 不是图库内容，从别的 Kanitsu 图库目录导入时不应被再次卷入。
            if (child.name.equals(".kanitsu-cache") || child.name.equals(".kanitsu-library.json")) {
                continue;
            }
            String childRel = relPath.isEmpty() ? child.name : relPath + "/" + child.name;
            if (child.kind.equals("folder")) {
                // SAF 提供方可控名字（如 ".."）：过 sanitize 且最终目录必须仍在库内。
                File sub = new File(dstDir, AlbumLibrary.sanitize(child.name));
                albums.assertInside(sub);
                sub.mkdirs();
                if (!sub.isDirectory()) {
                    throw new IOException("创建目录失败：" + childRel);
                }
                walk(child.id, sub, childRel, scanned, copied, skipped, skippedFiles, errors, albums, emitter, cancel);
            } else {
                scanned[0]++;
                String ext = AlbumLibrary.extOf(child.name);
                if (IMAGE_EXT.contains(ext)) {
                    try {
                        Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, child.id);
                        try (InputStream input = context.getContentResolver().openInputStream(docUri)) {
                            if (input == null) {
                                throw new IOException("无法打开文件");
                            }
                            albums.write(dstDir, child.name, input);
                        }
                        copied[0]++;
                    } catch (Exception e) {
                        errors.add(child.name + ": " + String.valueOf(e.getMessage()));
                    }
                } else {
                    skipped[0]++;
                    JSObject s = new JSObject();
                    s.put("path", childRel);
                    s.put("reason", ext.isEmpty() ? "no-extension" : "unsupported-format");
                    skippedFiles.add(s);
                }
                emitter.emit(scanned[0], copied[0], skipped[0], child.name);
            }
        }
    }

    private static long safeLong(Cursor c, int index) {
        try {
            if (c.isNull(index)) {
                return 0L;
            }
            return c.getLong(index);
        } catch (Exception e) {
            return 0L;
        }
    }
}
