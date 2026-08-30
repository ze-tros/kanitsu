package com.kanitsu.viewer;

import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.kanitsu.viewer.kanitsu.KanitsuPlugin;

public class MainActivity extends BridgeActivity {
    private boolean backDispatchPending;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KanitsuPlugin.class);
        super.onCreate(savedInstanceState);

        // The mobile UI owns a small history stack for folders and overlays. Let it
        // consume the Android back gesture first, and only finish the Activity when
        // the web UI reports that it has nothing left to close.
        getOnBackPressedDispatcher().addCallback(
                this,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        if (backDispatchPending) return;

                        WebView webView = getBridge().getWebView();
                        if (webView == null) {
                            dispatchSystemBack(this);
                            return;
                        }

                        backDispatchPending = true;
                        webView.evaluateJavascript(
                                "(function(){try{var e=new CustomEvent('kanitsu:android-back',{cancelable:true});return window.dispatchEvent(e)?'unhandled':'handled';}catch(_){return 'unhandled';}})();",
                                value -> {
                                    backDispatchPending = false;
                                    if (!"\"handled\"".equals(value)) {
                                        dispatchSystemBack(this);
                                    }
                                });
                    }
                });

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

    private void dispatchSystemBack(OnBackPressedCallback callback) {
        callback.setEnabled(false);
        try {
            getOnBackPressedDispatcher().onBackPressed();
        } finally {
            // A stopped Activity can be brought forward again without recreation.
            // Re-enable the bridge so future back presses still reach the web UI.
            callback.setEnabled(true);
        }
    }
}
