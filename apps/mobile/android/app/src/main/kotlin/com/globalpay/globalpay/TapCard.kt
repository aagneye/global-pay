package com.globalpay.globalpay

import android.content.Context
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.cardemulation.HostApduService
import android.os.Build
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Tap to pay, sender's side (ADR 0010). This phone acts as a contactless card with GlobalPay's own AID
 * (res/xml/apduservice.xml). lib/services/tap/tap_protocol.dart is the other half and must match:
 *
 *   SELECT F0 47 50 41 59 00 01        → device ID (UTF-8), 90 00
 *   80 10 00 00 20 <32-byte challenge> → SHA256withECDSA (DER) over "GLOBALPAY-TAP-1" ‖ challenge, 90 00
 *
 * It answers only while armed (the "Pay by tap" screen is open), otherwise 69 85. The signing key never
 * leaves the Android Keystore; the signature only identifies this phone, and the payment still needs the
 * owner's approval with their fingerprint.
 */
object TapState {
    private const val PREFS = "globalpay_tap"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun deviceId(context: Context): String? = prefs(context).getString("deviceId", null)

    fun setDeviceId(context: Context, id: String) = prefs(context).edit().putString("deviceId", id).apply()

    fun arm(context: Context, seconds: Int) =
        prefs(context).edit().putLong("armedUntil", System.currentTimeMillis() + seconds * 1000L).apply()

    fun disarm(context: Context) = prefs(context).edit().remove("armedUntil").apply()

    fun isArmed(context: Context): Boolean = System.currentTimeMillis() < prefs(context).getLong("armedUntil", 0)

    fun isSupported(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION) &&
            NfcAdapter.getDefaultAdapter(context) != null
}

/** The phone's P-256 key in the Android Keystore (StrongBox when the phone has one). */
object DeviceKey {
    private const val ALIAS = "globalpay_device_p256"
    private const val PREFIX = "GLOBALPAY-TAP-1"

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** The public key as SPKI DER, base64, creating the key pair on first use. */
    fun publicKey(): String {
        val store = keyStore()
        if (!store.containsAlias(ALIAS)) create()
        return Base64.encodeToString(store.getCertificate(ALIAS).publicKey.encoded, Base64.NO_WRAP)
    }

    fun signTap(challenge: ByteArray): ByteArray? {
        val key = keyStore().getKey(ALIAS, null) as? PrivateKey ?: return null
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(PREFIX.toByteArray(Charsets.US_ASCII))
            update(challenge)
            sign()
        }
    }

    private fun create() {
        fun spec(strongBox: Boolean) =
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
                .build()

        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try {
            generator.initialize(spec(strongBox = true))
            generator.generateKeyPair()
        } catch (e: Exception) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && e !is StrongBoxUnavailableException && e.cause !is StrongBoxUnavailableException) throw e
            generator.initialize(spec(strongBox = false))
            generator.generateKeyPair()
        }
    }
}

/** Answers the receiver's phone. Runs even when the app is in the background, but only while armed. */
class TapHostApduService : HostApduService() {
    override fun processCommandApdu(command: ByteArray, extras: Bundle?): ByteArray {
        if (!TapState.isArmed(this)) return NOT_READY
        return when {
            isSelect(command) -> TapState.deviceId(this)?.let { it.toByteArray(Charsets.UTF_8) + OK } ?: NOT_READY
            isSign(command) -> {
                val challenge = command.copyOfRange(5, 5 + CHALLENGE_LENGTH)
                DeviceKey.signTap(challenge)?.let { it + OK } ?: NOT_READY
            }
            else -> UNKNOWN_INSTRUCTION
        }
    }

    override fun onDeactivated(reason: Int) {}

    private fun isSelect(apdu: ByteArray) =
        apdu.size >= 5 + AID.size && apdu[0] == 0x00.toByte() && apdu[1] == 0xA4.toByte() && apdu[2] == 0x04.toByte() &&
            apdu[4].toInt() == AID.size && apdu.copyOfRange(5, 5 + AID.size).contentEquals(AID)

    private fun isSign(apdu: ByteArray) =
        apdu.size >= 5 + CHALLENGE_LENGTH && apdu[0] == 0x80.toByte() && apdu[1] == 0x10.toByte() && apdu[4].toInt() == CHALLENGE_LENGTH

    companion object {
        private val AID = byteArrayOf(0xF0.toByte(), 0x47, 0x50, 0x41, 0x59, 0x00, 0x01)
        private const val CHALLENGE_LENGTH = 32
        private val OK = byteArrayOf(0x90.toByte(), 0x00)
        private val NOT_READY = byteArrayOf(0x69, 0x85.toByte())
        private val UNKNOWN_INSTRUCTION = byteArrayOf(0x6D, 0x00)
    }
}
