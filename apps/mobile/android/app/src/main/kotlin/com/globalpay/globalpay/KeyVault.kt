package com.globalpay.globalpay

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import io.flutter.plugin.common.MethodChannel
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the wallet key encrypted by an AES key in the Android Keystore that needs a strong biometric
 * (fingerprint or face) for every single use: the cipher is only unlocked through BiometricPrompt with a
 * CryptoObject, so the plaintext key exists only for one signature (lib/services/tap/tap_services.dart,
 * KeyVault). Enrolling a new fingerprint invalidates the key.
 *
 * It also seals the token that the Privy wallet's fingerprint check opens before every signature
 * (lib/services/wallet/signature_gate.dart).
 */
class KeyVault(private val activity: FragmentActivity) {
    private val alias = "globalpay_wallet_vault"

    fun isAvailable(): Boolean = BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

    /**
     * Encrypts `secret`, after a fingerprint; returns "iv:ciphertext" in base64. If fingerprints changed
     * since the key was made, Android has invalidated it and nothing it sealed can be opened again, so a
     * new key replaces it.
     */
    fun seal(secret: String, reason: String, result: MethodChannel.Result) {
        val cipher = try {
            try {
                encryptCipher()
            } catch (e: KeyPermanentlyInvalidatedException) {
                deleteKey()
                encryptCipher()
            }
        } catch (e: Exception) {
            return result.error("failed", "Couldn't prepare the vault: ${e.message}", null)
        }
        prompt(cipher, reason, result) { unlocked ->
            val sealed = unlocked.doFinal(secret.toByteArray(Charsets.UTF_8))
            "${encode(unlocked.iv)}:${encode(sealed)}"
        }
    }

    /** Decrypts what `seal` returned, after a fingerprint. */
    fun open(sealed: String, reason: String, result: MethodChannel.Result) {
        val parts = sealed.split(':')
        if (parts.size != 2) return result.error("failed", "The stored wallet key is damaged", null)
        val cipher = try {
            Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key(createIfMissing = false), GCMParameterSpec(128, decode(parts[0])))
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            return result.error("invalidated", "Your fingerprints changed, so the wallet key can no longer be unlocked", null)
        } catch (e: Exception) {
            return result.error("failed", "Couldn't open the vault: ${e.message}", null)
        }
        prompt(cipher, reason, result) { unlocked -> String(unlocked.doFinal(decode(parts[1])), Charsets.UTF_8) }
    }

    private fun prompt(cipher: Cipher, reason: String, result: MethodChannel.Result, use: (Cipher) -> String) {
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
            .setNegativeButtonText("Cancel")
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }

    private fun encryptCipher(): Cipher =
        Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key(createIfMissing = true)) }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun deleteKey() = keyStore().deleteEntry(alias)

    private fun key(createIfMissing: Boolean): SecretKey {
        val store = keyStore()
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (!createIfMissing) throw IllegalStateException("No wallet vault key")
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                // Every use needs its own strong biometric check.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
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
