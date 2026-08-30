package com.kanitsu.viewer;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import com.getcapacitor.BridgeActivity;
import com.kanitsu.viewer.kanitsu.KanitsuPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KanitsuPlugin.class);
        super.onCreate(savedInstanceState);

        // 状态栏与页面画布、导航栏与底部操作区分别对齐，避免 WebView 边缘颜色割裂。
        // 必须在 super.onCreate() 之后设置：在系统启动 SplashScreen 未就绪前操作
        // window 会干扰其退出动画（导致应用名+加载动画的 Splash 卡在顶部）。
        boolean isNight =
                (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                        == Configuration.UI_MODE_NIGHT_YES;
        int statusBarBg = isNight ? 0xFF0E1014 : 0xFFE7E9ED;
        int navigationBarBg = isNight ? 0xFF16191F : 0xFFFAFBFC;
        getWindow().setStatusBarColor(statusBarBg);
        getWindow().setNavigationBarColor(navigationBarBg);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int vis = getWindow().getDecorView().getSystemUiVisibility();
            if (isNight) {
                vis &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                vis |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (isNight) {
                    vis &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                } else {
                    vis |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            getWindow().getDecorView().setSystemUiVisibility(vis);
        }
    }
}
