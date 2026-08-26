package com.kanitu.viewer.kanitu;

import com.getcapacitor.JSObject;

/** Lightweight bridge entry shared by SAF documents and app album files. */
public final class AndroidEntry {
    public final String id;
    public final String name;
    public final String kind;
    public final long size;
    public final long mtime;
    public final int width;
    public final int height;

    private AndroidEntry(String id, String name, String kind, long size, long mtime, int width, int height) {
        this.id = id;
        this.name = name;
        this.kind = kind;
        this.size = size;
        this.mtime = mtime;
        this.width = width;
        this.height = height;
    }

    public static AndroidEntry folder(String id, String name) {
        return new AndroidEntry(id, name, "folder", 0, 0, 0, 0);
    }

    public static AndroidEntry file(String id, String name, long size, long mtime, int width, int height) {
        return new AndroidEntry(id, name, "file", size, mtime, width, height);
    }

    public JSObject toJS() {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("name", name);
        o.put("kind", kind);
        if ("file".equals(kind)) {
            o.put("size", size);
            o.put("mtime", mtime);
            o.put("width", width);
            o.put("height", height);
        }
        return o;
    }

    public static AndroidEntry fromJS(JSObject o) {
        String id = o.optString("id", "");
        String name = o.optString("name", "");
        String kind = o.optString("kind", "file");
        long size = o.optLong("size", 0L);
        long mtime = o.optLong("mtime", 0L);
        int width = o.optInt("width", 0);
        int height = o.optInt("height", 0);
        if ("folder".equals(kind)) {
            return folder(id, name);
        }
        return file(id, name, size, mtime, width, height);
    }
}
