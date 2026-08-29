package com.kanitsu.viewer.kanitsu;

/** Emits import/export progress to the JS bridge. */
public interface ProgressEmitter {
    void emit(int done, int total, int extra, String current);
}
