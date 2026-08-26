package com.kanitu.viewer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.kanitu.viewer.kanitu.KanituPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KanituPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
