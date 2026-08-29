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

        // 状态栏/导航栏颜色与 web 内容顶部（导航栏 base-200）一致，避免颜色割裂。
        // 必须在 super.onCreate() 之后设置：在系统启动 SplashScreen 未就绪前操作
        // window 会干扰其退出动画（导致应用名+加载动画的 Splash 卡在顶部）。
        boolean isNight =
                (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                        == Configuration.UI_MODE_NIGHT_YES;
        int barBg = isNight ? 0xFF23272E : 0xFFFAFAFA; // daisyui: dark/base-200 与 light/base-200
        getWindow().setStatusBarColor(barBg);
        getWindow().setNavigationBarColor(barBg);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int vis = getWindow().getDecorView().getSystemUiVisibility();
            if (isNight) {
                vis &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                vis |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(vis);
        }
    }
}
