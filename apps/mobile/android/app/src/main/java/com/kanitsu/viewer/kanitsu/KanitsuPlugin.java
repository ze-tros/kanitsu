package com.kanitsu.viewer.kanitsu;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.io.File;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Capacitor bridge for SAF import, album library, thumbnails and zip export. */
@CapacitorPlugin(name = "Kanitsu")
public class KanitsuPlugin extends Plugin {

    // 有界线程池：大图库快速滚动时可见卡片 + 各级预取会同时发出大量缩略图请求，
    // 无界 cachedThreadPool 会为每个请求各起一个线程并发解码，堆内存瞬间被打爆
    // （OOM 闪退）。固定小池限制线程总数，解码并发再由 ThumbnailService 内部的
    // 信号量进一步收口到常数，保证同时解码的图片数有硬上限。
    private final ExecutorService executor =
        Executors.newFixedThreadPool(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors())));
    private final ArrayDeque<String> logBuffer = new ArrayDeque<>();
    private String logLevel = "info";

    private SafSource safSource;
    private AlbumLibrary albums;
    private ThumbnailService thumbnails;
    private DerivativeService derivatives;
    private ZipExportService zipExport;

    /** 进行中的可取消任务（导入/导出）：token -> 取消标志。 */
    private final Map<String, AtomicBoolean> taskCancels = new ConcurrentHashMap<>();
    private String pendingExportToken = "";

    private AtomicBoolean registerCancel(String token) {
        AtomicBoolean c = new AtomicBoolean(false);
        if (token != null && !token.isEmpty()) {
            taskCancels.put(token, c);
        }
        return c;
    }

    private void unregisterCancel(String token, AtomicBoolean cancel) {
        if (token != null && !token.isEmpty() && taskCancels.get(token) == cancel) {
            taskCancels.remove(token);
        }
    }

    @Override
    public void load() {
        super.load();
        safSource = new SafSource(getContext());
        albums = new AlbumLibrary(getContext());
        thumbnails = new ThumbnailService(getContext());
        derivatives = new DerivativeService(getContext());
        zipExport = new ZipExportService(getContext());
    }

    // ------------------------------------------------------------------
    // System bars
    // ------------------------------------------------------------------

    /** 应用内主题切换时同步状态栏/导航栏底色与图标明暗（setSystemTheme: { dark, statusBarColor?, navBarColor? }）。
     *  色值由 JS 从设计令牌算出后下发，这里同时持久化，供 MainActivity 冷启动预置
     *  （不再按系统 uiMode 猜应用内偏好）。 */
    @PluginMethod
    public void setSystemTheme(PluginCall call) {
        Boolean dark = call.getBoolean("dark");
        if (dark == null) {
            call.reject("missing dark");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("activity unavailable");
            return;
        }
        String statusColor = call.getString("statusBarColor");
        String navColor = call.getString("navBarColor");
        Integer status = com.kanitsu.viewer.SystemBars.parseColor(statusColor);
        Integer nav = com.kanitsu.viewer.SystemBars.parseColor(navColor);
        getContext()
                .getSharedPreferences("kanitsu-ui", android.content.Context.MODE_PRIVATE)
                .edit()
                .putBoolean("system_dark", dark)
                .putString("status_bar_color", statusColor)
                .putString("nav_bar_color", navColor)
                .apply();
        activity.runOnUiThread(() -> com.kanitsu.viewer.SystemBars.apply(activity, dark, status, nav));
        call.resolve();
    }

    // ------------------------------------------------------------------
    // SAF source
    // ------------------------------------------------------------------

    @PluginMethod
    public void pickSourceFolder(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(call, intent, "pickSourceFolderResult");
        });
    }

    @ActivityCallback
    private void pickSourceFolderResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve();
            return;
        }
        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.resolve();
            return;
        }
        try {
            int flags = result.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContext().getContentResolver().takePersistableUriPermission(treeUri, flags);
        } catch (Exception ignored) {
        }
        safSource.setTreeUri(treeUri);
        JSObject out = new JSObject();
        out.put("id", safSource.rootDocumentId());
        out.put("name", safSource.rootDisplayName());
        out.put("kind", "folder");
        call.resolve(out);
    }

    @PluginMethod
    public void listSourceChildren(PluginCall call) {
        AndroidEntry folder = AndroidEntry.fromJS(call.getObject("folder"));
        List<AndroidEntry> list = safSource.listChildren(folder.id);
        JSONArray arr = new JSONArray();
        for (AndroidEntry e : list) {
            arr.put(e.toJS());
        }
        JSObject out = new JSObject();
        out.put("entries", arr);
        call.resolve(out);
    }

    @PluginMethod
    public void readSourceBlob(PluginCall call) {
        AndroidEntry file = AndroidEntry.fromJS(call.getObject("file"));
        executor.execute(() -> {
            try {
                byte[] bytes = safSource.readBytes(file.id);
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                out.put("mime", safSource.mimeOfName(file.name));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void releaseSource(PluginCall call) {
        safSource.release();
        call.resolve();
    }

    @PluginMethod
    public void importSourceTree(PluginCall call) {
        JSObject source = call.getObject("source");
        String targetTopName = call.getString("targetTopName", "未命名相册");
        String cancelToken = call.getString("cancelToken", "");
        executor.execute(() -> {
            AtomicBoolean cancel = registerCancel(cancelToken);
            try {
                AndroidEntry src = AndroidEntry.fromJS(source);
                JSObject result = safSource.importTree(targetTopName, albums, importEmitter(), cancel);
                call.resolve(result);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            } finally {
                unregisterCancel(cancelToken, cancel);
            }
        });
    }

    // ------------------------------------------------------------------
    // Album library
    // ------------------------------------------------------------------

    @PluginMethod
    public void getLibraryRoot(PluginCall call) {
        call.resolve(albums.rootEntry().toJS());
    }

    @PluginMethod
    public void ensureLibraryRoot(PluginCall call) {
        call.resolve(albums.rootEntry().toJS());
    }

    @PluginMethod
    public void createLibraryFolder(PluginCall call) {
        try {
            AndroidEntry parent = AndroidEntry.fromJS(call.getObject("parent"));
            String name = call.getString("name", "");
            call.resolve(albums.createFolder(albums.fileForId(parent.id), name).toJS());
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void createTopLibraryFolder(PluginCall call) {
        try {
            String name = call.getString("name", "未命名相册");
            call.resolve(albums.createUniqueTopFolder(name).toJS());
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void writeLibraryBlob(PluginCall call) {
        AndroidEntry folder = AndroidEntry.fromJS(call.getObject("folder"));
        String name = call.getString("name", "");
        byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        executor.execute(() -> {
            try {
                call.resolve(albums.write(albums.fileForId(folder.id), name, data).toJS());
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void listLibraryChildren(PluginCall call) {
        try {
            AndroidEntry folder = AndroidEntry.fromJS(call.getObject("folder"));
            List<AndroidEntry> list = albums.listChildren(albums.fileForId(folder.id));
            JSONArray arr = new JSONArray();
            for (AndroidEntry e : list) {
                arr.put(e.toJS());
            }
            JSObject out = new JSObject();
            out.put("entries", arr);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void readLibraryBlob(PluginCall call) {
        AndroidEntry file = AndroidEntry.fromJS(call.getObject("file"));
        executor.execute(() -> {
            try {
                File f = albums.fileForId(file.id);
                byte[] bytes = albums.read(f);
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                out.put("mime", albums.mimeOf(f));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void readLibrarySlice(PluginCall call) {
        AndroidEntry file = AndroidEntry.fromJS(call.getObject("file"));
        long offset = call.getLong("offset", 0L);
        int length = call.getInt("length", 0);
        executor.execute(() -> {
            try {
                byte[] bytes = albums.readSlice(albums.fileForId(file.id), offset, length);
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void readLibraryThumbnail(PluginCall call) {
        AndroidEntry file = AndroidEntry.fromJS(call.getObject("file"));
        int maxSize = call.getInt("maxSize", 512);
        int priority = call.getInt("priority", 0);
        executor.execute(() -> {
            try {
                ThumbnailService.Result r = thumbnails.getOrCreate(albums.fileForId(file.id), maxSize, priority);
                JSObject out = new JSObject();
                out.put("data", Base64.encodeToString(r.data, Base64.NO_WRAP));
                out.put("mime", r.mime);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void moveLibraryEntry(PluginCall call) {
        try {
            AndroidEntry entry = AndroidEntry.fromJS(call.getObject("entry"));
            AndroidEntry toFolder = AndroidEntry.fromJS(call.getObject("toFolder"));
            String newName = call.getString("newName", null);
            call.resolve(albums.move(albums.fileForId(entry.id), albums.fileForId(toFolder.id), newName).toJS());
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void removeLibraryEntry(PluginCall call) {
        try {
            AndroidEntry entry = AndroidEntry.fromJS(call.getObject("entry"));
            albums.remove(albums.fileForId(entry.id));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    @PluginMethod
    public void getLibraryFingerprint(PluginCall call) {
        JSObject out = new JSObject();
        out.put("fingerprint", albums.fingerprint());
        call.resolve(out);
    }

    @PluginMethod
    public void getViewerUrl(PluginCall call) {
        AndroidEntry file = AndroidEntry.fromJS(call.getObject("file"));
        JSObject out = new JSObject();
        out.put("url", servedUrlFor(file.id));
        call.resolve(out);
    }

    /** HEIF/HEIC 全图查看:WebView 解不了 HEVC,原生解码为 JPEG 落盘缓存
     *  (userData 外的 derivatives 目录,不进图库扫描),返回派生图 URL。
     *  二次打开命中磁盘缓存即时返回;首访等待原生解码(秒级)。 */
    @PluginMethod
    public void ensureViewerDerivative(PluginCall call) {
        AndroidEntry file = AndroidEntry.fromJS(call.getObject("file"));
        executor.execute(() -> {
            try {
                File deriv = derivatives.getOrCreate(albums.fileForId(file.id));
                JSObject out = new JSObject();
                out.put("url", servedUrlFor(deriv.getAbsolutePath()));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            }
        });
    }

    // ------------------------------------------------------------------
    // Zip export
    // ------------------------------------------------------------------

    @PluginMethod
    public void exportZip(PluginCall call) {
        String target = call.getString("targetRelPath", "");
        pendingExportToken = call.getString("cancelToken", "");
        getActivity().runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/zip");
            String archiveName = call.getString("archiveName", "");
            String base = archiveName != null && !archiveName.isEmpty()
                    ? archiveName
                    : target.isEmpty() ? "相册" : baseName(target);
            intent.putExtra(Intent.EXTRA_TITLE, base + ".zip");
            startActivityForResult(call, intent, "exportZipResult");
        });
    }

    @ActivityCallback
    private void exportZipResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject out = new JSObject();
            out.put("canceled", true);
            call.resolve(out);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            JSObject out = new JSObject();
            out.put("canceled", true);
            call.resolve(out);
            return;
        }
        String target = call.getString("targetRelPath", "");
        String cancelToken = pendingExportToken;
        // 多选导出：只打包列出的 relPath（为空/缺省时导出整个目标目录）。
        Set<String> include = null;
        JSArray includeArr = call.getArray("includeRelPaths");
        if (includeArr != null) {
            include = new HashSet<>();
            for (int i = 0; i < includeArr.length(); i++) {
                String rel = includeArr.optString(i, "");
                if (!rel.isEmpty()) include.add(rel.replace('\\', '/'));
            }
        }
        final Set<String> includeSet = include;
        executor.execute(() -> {
            AtomicBoolean cancel = registerCancel(cancelToken);
            try {
                int[] counts = zipExport.export(albums, target, includeSet, uri, exportEmitter(), cancel);
                JSObject out = new JSObject();
                out.put("canceled", cancel.get());
                out.put("outputPath", uri.toString());
                out.put("totalImages", counts[0]);
                out.put("exportedCount", counts[1]);
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.getMessage(), e);
            } finally {
                unregisterCancel(cancelToken, cancel);
            }
        });
    }

    // ------------------------------------------------------------------
    // Debug / cache
    // ------------------------------------------------------------------

    @PluginMethod
    public void getThumbnailStats(PluginCall call) {
        JSONArray q = new JSONArray();
        for (int v : thumbnails.queuedByPriority()) {
            q.put(v);
        }
        JSObject out = new JSObject();
        out.put("queuedByPriority", q);
        out.put("inFlight", thumbnails.inFlight());
        out.put("diskFiles", thumbnails.diskFiles());
        out.put("diskBytes", thumbnails.diskBytes());
        call.resolve(out);
    }

    @PluginMethod
    public void clearCaches(PluginCall call) {
        thumbnails.clear();
        derivatives.clear();
        call.resolve();
    }

    @PluginMethod
    public void cancelTask(PluginCall call) {
        String token = call.getString("token", "");
        AtomicBoolean c = taskCancels.get(token);
        if (c != null) {
            c.set(true);
        }
        call.resolve();
    }

    @PluginMethod
    public void setLogLevel(PluginCall call) {
        logLevel = call.getString("level", "info");
        call.resolve();
    }

    @PluginMethod
    public void readLogs(PluginCall call) {
        int max = call.getInt("maxLines", 200);
        JSONArray arr = new JSONArray();
        int skip = Math.max(0, logBuffer.size() - max);
        int i = 0;
        for (String line : logBuffer) {
            if (i++ >= skip) {
                arr.put(line);
            }
        }
        JSObject out = new JSObject();
        out.put("lines", arr);
        call.resolve(out);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** 把库内(或派生缓存)绝对路径拼成 _capacitor_file_ 流式 URL。
     *  用 getLocalUrl()（实际服务 origin，如 https://localhost/）而不是 getServerUrl()
     *（读 config.server.url，默认 null——会导致拼出 "null/_capacitor_file_/..." 的
     * 非法 URL，全图加载失败、查看器只显示缩略图）。 */
    private String servedUrlFor(String absPath) {
        String base = getBridge().getLocalUrl();
        if (base == null) {
            base = getBridge().getServerUrl();
        }
        if (base == null) {
            base = "";
        }
        // 文件路径含空格 / 方括号 / 括号等特殊字符，需转义（Uri.encode 保留 '/'）。
        return base.replaceAll("/+$", "") + Bridge.CAPACITOR_FILE_START + Uri.encode(absPath, "/");
    }

    private ProgressEmitter importEmitter() {
        final long[] lastEmitAt = { 0L };
        return (scanned, copied, skipped, current) -> {
            long now = System.nanoTime();
            if (lastEmitAt[0] != 0L && now - lastEmitAt[0] < 100_000_000L) {
                return;
            }
            lastEmitAt[0] = now;
            JSObject o = new JSObject();
            o.put("scanned", scanned);
            o.put("copied", copied);
            o.put("skipped", skipped);
            if (current != null) {
                o.put("current", current);
            }
            notifyListeners("importProgress", o);
        };
    }

    private ProgressEmitter exportEmitter() {
        return (done, total, extra, current) -> {
            JSObject o = new JSObject();
            o.put("done", done);
            o.put("total", total);
            notifyListeners("exportProgress", o);
        };
    }

    private void log(String level, String msg) {
        if (logBuffer.size() >= 300) {
            logBuffer.removeFirst();
        }
        logBuffer.addLast(System.currentTimeMillis() + " [" + level + "] " + msg);
    }

    private static String baseName(String relPath) {
        String p = relPath == null ? "" : relPath.replace('\\', '/');
        int i = p.lastIndexOf('/');
        return i < 0 ? p : p.substring(i + 1);
    }
}
