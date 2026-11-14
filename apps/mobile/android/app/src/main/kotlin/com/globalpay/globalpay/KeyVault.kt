package com.globalpay.globalpay

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import io.flutter.plugin.common.MethodChannel
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the wallet key encrypted by an AES key in the Android Keystore that needs a strong biometric
 * (fingerprint or face) for every single use: the cipher is only unlocked through BiometricPrompt with a
 * CryptoObject, so the plaintext key exists only for one signature (lib/services/tap/tap_services.dart,
 * KeyVault). Enrolling a new fingerprint invalidates the key.
 *
 * On a phone without a strong biometric (most face unlock is weak), Android 11 and later let the screen
 * lock (PIN, pattern or password) unlock the key instead. Which kind a key is gets fixed when it's made,
 * and changing fingerprints doesn't invalidate a key the screen lock opens. Removing the screen lock
 * invalidates either kind.
 *
 * It also seals the token that the Privy wallet's fingerprint check opens before every signature
 * (lib/services/wallet/signature_gate.dart).
 */
class KeyVault(private val activity: FragmentActivity) {
    private val alias = "globalpay_wallet_vault"

    fun isAvailable(): Boolean = newKeyAuthenticators() != null

    /**
     * Encrypts `secret`, after a fingerprint; returns "iv:ciphertext" in base64. If fingerprints changed
     * since the key was made, Android has invalidated it and nothing it sealed can be opened again, so a
     * new key replaces it.
     */
    fun seal(secret: String, reason: String, result: MethodChannel.Result) {
        val (cipher, authenticators) = try {
            try {
                unlockable(Cipher.ENCRYPT_MODE)
            } catch (e: KeyPermanentlyInvalidatedException) {
                deleteKey()
                unlockable(Cipher.ENCRYPT_MODE)
            }
        } catch (e: Exception) {
            return result.error("failed", "Couldn't prepare the vault: ${e.message}", null)
        }
        prompt(cipher, authenticators, reason, result) { unlocked ->
            val sealed = unlocked.doFinal(secret.toByteArray(Charsets.UTF_8))
            "${encode(unlocked.iv)}:${encode(sealed)}"
        }
    }

    /** Decrypts what `seal` returned, after a fingerprint. */
    fun open(sealed: String, reason: String, result: MethodChannel.Result) {
        val parts = sealed.split(':')
        if (parts.size != 2) return result.error("failed", "The stored wallet key is damaged", null)
        val (cipher, authenticators) = try {
            unlockable(Cipher.DECRYPT_MODE, GCMParameterSpec(128, decode(parts[0])))
        } catch (e: KeyPermanentlyInvalidatedException) {
            return result.error("invalidated", "Your fingerprints or screen lock changed, so the wallet key can no longer be unlocked", null)
        } catch (e: Exception) {
            return result.error("failed", "Couldn't open the vault: ${e.message}", null)
        }
        prompt(cipher, authenticators, reason, result) { unlocked -> String(unlocked.doFinal(decode(parts[1])), Charsets.UTF_8) }
    }

    /** A cipher on the vault key (made if missing when encrypting), and what the prompt must accept to unlock it. */
    private fun unlockable(mode: Int, params: GCMParameterSpec? = null): Pair<Cipher, Int> {
        val key = key(createIfMissing = mode == Cipher.ENCRYPT_MODE)
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { if (params == null) init(mode, key) else init(mode, key, params) }
        return cipher to promptAuthenticators(key)
    }

    private fun prompt(cipher: Cipher, authenticators: Int, reason: String, result: MethodChannel.Result, use: (Cipher) -> String) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(auth: BiometricPrompt.AuthenticationResult) {
                val unlocked = auth.cryptoObject?.cipher ?: return result.error("failed", "No unlocked key", null)
                try {
                    result.success(use(unlocked))
                } catch (e: Exception) {
                    result.error("failed", "Fingerprint check passed, but the key couldn't be used: ${e.message}", null)
                }
            }

            override fun onAuthenticationError(code: Int, message: CharSequence) {
                val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    code == BiometricPrompt.ERROR_CANCELED
                result.error(if (cancelled) "cancelled" else "failed", message.toString(), null)
            }
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(reason)
            .setAllowedAuthenticators(authenticators)
            .apply {
                // With the screen lock allowed, the system draws its own way out; a Cancel button isn't allowed.
                if (authenticators and DEVICE_CREDENTIAL == 0) setNegativeButtonText("Cancel")
            }
            .build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    /**
     * What a new key will accept: a strong biometric when one is set up. Otherwise, on Android 11 and later
     * with a screen lock, the screen lock too (a strong biometric added later also works). Null: neither,
     * so the vault can't be used. Crypto with the screen lock needs Android 11.
     */
    private fun newKeyAuthenticators(): Int? {
        when (BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS -> return BIOMETRIC_STRONG
            // Only when the phone surely has no strong biometric, not when the sensor is busy or its state
            // unknown: a phone with a fingerprint must never get a key its PIN opens.
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED, BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> Unit
            else -> return null
        }
        val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && keyguard.isDeviceSecure) return BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        return null
    }

    /** What an existing key accepts, read back from the Keystore, so the prompt always matches the key. */
    private fun promptAuthenticators(key: SecretKey): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return BIOMETRIC_STRONG
        val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
        return if (info.userAuthenticationType and KeyProperties.AUTH_DEVICE_CREDENTIAL != 0) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun deleteKey() = keyStore().deleteEntry(alias)

    private fun key(createIfMissing: Boolean): SecretKey {
        val store = keyStore()
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!createIfMissing) throw IllegalStateException("No wallet vault key")
        val authenticators = newKeyAuthenticators() ?: throw IllegalStateException("No fingerprint or screen lock is set up")
        val screenLock = authenticators and DEVICE_CREDENTIAL != 0
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // A key the screen lock opens gains nothing from being tied to today's fingerprints. Tied to them,
            // a fingerprint added later would pass the prompt and then be refused by the key.
            .setInvalidatedByBiometricEnrollment(!screenLock)
            .apply {
                // Every use needs its own check.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val types = if (screenLock) KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL else KeyProperties.AUTH_BIOMETRIC_STRONG
                    setUserAuthenticationParameters(0, types)
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(-1)
                }
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(spec)
            generateKey()
        }
    }

    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun decode(text: String) = Base64.decode(text, Base64.NO_WRAP)

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
