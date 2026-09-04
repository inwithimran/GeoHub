package com.geohubmmc.app

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val url = intent?.getStringExtra("geohub_url") ?: return
        intent.removeExtra("geohub_url")
        val escaped = url.replace("\\", "\\\\").replace("\"", "\\\"")
        bridge?.triggerJSEvent("geohubNotificationTap", "window", "\"$escaped\"")
    }
}
