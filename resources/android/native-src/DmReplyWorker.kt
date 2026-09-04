package com.geohubmmc.app

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

class DmReplyWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val text = inputData.getString(KEY_TEXT) ?: return@withContext Result.failure()
        val targetUid = inputData.getString(KEY_TARGET_UID) ?: return@withContext Result.failure()

        val user = FirebaseAuth.getInstance().currentUser ?: return@withContext Result.failure()
        val idToken = try {
            Tasks.await(user.getIdToken(false), 15, TimeUnit.SECONDS).token
        } catch (e: Exception) {
            return@withContext Result.retry()
        } ?: return@withContext Result.retry()

        try {
            val url = URL("$API_BASE/api/send-dm-message")
            val connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Authorization", "Bearer $idToken")
            connection.doOutput = true
            connection.connectTimeout = 15000
            connection.readTimeout = 15000

            val payload = JSONObject().apply {
                put("targetUid", targetUid)
                put("text", text)
            }
            connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }

            val code = connection.responseCode
            connection.disconnect()
            when {
                code in 200..299 -> Result.success()
                code == 429 || code >= 500 -> Result.retry()
                else -> Result.failure()
            }
        } catch (e: Exception) {
            Result.retry()
        }
    }

    companion object {
        const val KEY_TEXT = "geohub_reply_text"
        const val KEY_TARGET_UID = "geohub_reply_target_uid"
        const val KEY_NOTIFICATION_ID = "geohub_reply_notification_id"
        const val API_BASE = "https://geohubmmc.vercel.app"
    }
}
