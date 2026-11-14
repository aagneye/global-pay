package com.globalpay.globalpay

import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/** A FragmentActivity, because BiometricPrompt needs one (KeyVault). */
class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger

        MethodChannel(messenger, "globalpay/tap_card").setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "isSupported" -> result.success(TapState.isSupported(this))
                    "publicKey" -> result.success(DeviceKey.publicKey())
                    "setDeviceId" -> result.success(TapState.setDeviceId(this, call.argument<String>("deviceId")!!).let { null })
                    "arm" -> result.success(TapState.arm(this, call.argument<Int>("seconds") ?: 60).let { null })
                    "disarm" -> result.success(TapState.disarm(this).let { null })
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("tap_card", e.message, null)
            }
        }

        val vault = KeyVault(this)
        MethodChannel(messenger, "globalpay/vault").setMethodCallHandler { call, result ->
            when (call.method) {
                "isAvailable" -> result.success(vault.isAvailable())
                "seal" -> vault.seal(call.argument<String>("secret")!!, call.argument<String>("reason") ?: "Confirm", result)
                "open" -> vault.open(call.argument<String>("sealed")!!, call.argument<String>("reason") ?: "Confirm", result)
                else -> result.notImplemented()
            }
        }
    }
}
