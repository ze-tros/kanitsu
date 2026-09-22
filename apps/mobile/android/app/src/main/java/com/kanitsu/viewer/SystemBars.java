package com.kanitsu.viewer;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;

/**
 * 系统栏配色与页面画布对齐：状态栏对齐画布底色，导航栏对齐底部操作区。
 * 色值由 JS 侧从设计令牌（--m-app/--m-surface-1）算出后经 setSystemTheme 下发，
 * 与 <meta name="theme-color"> 同源；这里的常量只是冷启动/无参调用的 fallback，
 * 与 mobile.css 令牌（--m-app / --m-surface-1）保持一致。
 * 首帧由 MainActivity 读上次保存的主题预置；应用内主题切换经 KanitsuPlugin.setSystemTheme 走到这里。
 */
public final class SystemBars {
    private static final int STATUS_BAR_DARK = 0xFF111112;
    private static final int STATUS_BAR_LIGHT = 0xFFE9EBEE;
    private static final int NAV_BAR_DARK = 0xFF18181A;
    private static final int NAV_BAR_LIGHT = 0xFFFBFCFD;

    private SystemBars() {}

    /** 注意：onCreate 中调用必须放在 super.onCreate() 之后，否则会干扰 SplashScreen 退出动画。 */
    public static void apply(Activity activity, boolean dark) {
        apply(activity, dark, null, null);
    }

    /** statusBar / navBar 为 null 时回落到与设计令牌一致的默认色。 */
    public static void apply(Activity activity, boolean dark, Integer statusBar, Integer navBar) {
        Window window = activity.getWindow();
        window.setStatusBarColor(statusBar != null ? statusBar : (dark ? STATUS_BAR_DARK : STATUS_BAR_LIGHT));
        window.setNavigationBarColor(navBar != null ? navBar : (dark ? NAV_BAR_DARK : NAV_BAR_LIGHT));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            View decor = window.getDecorView();
            int vis = decor.getSystemUiVisibility();
            if (dark) {
                vis &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                vis |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (dark) {
                    vis &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                } else {
                    vis |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            decor.setSystemUiVisibility(vis);
        }
    }

    /** 解析 JS 下发的 #RRGGBB / #AARRGGBB；无效或缺省返回 null（调用方走 fallback）。 */
    public static Integer parseColor(String value) {
        if (value == null || value.isEmpty()) return null;
        try {
            return Color.parseColor(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
