package com.kanitsu.viewer;

import android.app.Activity;
import android.os.Build;
import android.view.View;
import android.view.Window;

/**
 * 系统栏配色与页面画布对齐：状态栏对齐画布底色，导航栏对齐底部操作区。
 * 色值与 mobileShared.applyThemeMode 写入 <meta name="theme-color"> 的值保持一致。
 * 首帧由 MainActivity 按系统深色模式预置；应用内主题切换经 KanitsuPlugin.setSystemTheme 走到这里。
 */
public final class SystemBars {
    private static final int STATUS_BAR_DARK = 0xFF0E1014;
    private static final int STATUS_BAR_LIGHT = 0xFFE7E9ED;
    private static final int NAV_BAR_DARK = 0xFF16191F;
    private static final int NAV_BAR_LIGHT = 0xFFFAFBFC;

    private SystemBars() {}

    /** 注意：onCreate 中调用必须放在 super.onCreate() 之后，否则会干扰 SplashScreen 退出动画。 */
    public static void apply(Activity activity, boolean dark) {
        Window window = activity.getWindow();
        window.setStatusBarColor(dark ? STATUS_BAR_DARK : STATUS_BAR_LIGHT);
        window.setNavigationBarColor(dark ? NAV_BAR_DARK : NAV_BAR_LIGHT);
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
}
