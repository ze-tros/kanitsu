package com.kanitsu.viewer;

import android.content.res.Configuration;
import android.os.Bundle;
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
        // 首帧优先读应用内上次保存的主题（KanitsuPlugin.setSystemTheme 持久化），
        // 避免"应用内固定浅色 + 系统深色"这类场景启动瞬间系统栏明暗相反；首次安装
        // 无记录时回落到系统深色模式。JS 就绪后 setSystemTheme 会再校正一次。
        applySavedSystemBars();

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            // 禁用长按系统菜单（文本选择/“图片识别”浮层）：系统浮层会与应用内的
            // 长按动作面板同时弹出、层级打架；应用内长按手势由 JS 自行处理。
            webView.setOnLongClickListener(v -> true);
        }
    }

    private void applySavedSystemBars() {
        android.content.SharedPreferences prefs =
                getSharedPreferences("kanitsu-ui", MODE_PRIVATE);
        boolean isNight =
                (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                        == Configuration.UI_MODE_NIGHT_YES;
        if (!prefs.contains("system_dark")) {
            SystemBars.apply(this, isNight);
            return;
        }
        boolean dark = prefs.getBoolean("system_dark", isNight);
        Integer status = SystemBars.parseColor(prefs.getString("status_bar_color", null));
        Integer nav = SystemBars.parseColor(prefs.getString("nav_bar_color", null));
        SystemBars.apply(this, dark, status, nav);
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
