package com.geohubmmc.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

class DmReplyReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val replyText = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(KEY_REPLY_TEXT)?.toString()?.trim()
        val conversationId = intent.getStringExtra(EXTRA_CONVERSATION_ID)
        val targetUid = intent.getStringExtra(EXTRA_TARGET_UID)
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        if (replyText.isNullOrEmpty() || conversationId == null || targetUid == null) return

        val inputData = Data.Builder()
            .putString(DmReplyWorker.KEY_TEXT, replyText)
            .putString(DmReplyWorker.KEY_TARGET_UID, targetUid)
            .putInt(DmReplyWorker.KEY_NOTIFICATION_ID, notificationId)
            .build()

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val workRequest = OneTimeWorkRequestBuilder<DmReplyWorker>()
            .setInputData(inputData)
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(context).enqueue(workRequest)

        DmReplyMessagingService.ensureChannel(context)
        val iconRes = context.resources.getIdentifier("ic_stat_notify", "drawable", context.packageName)
        val ackNotification = NotificationCompat.Builder(context, DmReplyMessagingService.DM_CHANNEL_ID)
            .setSmallIcon(if (iconRes != 0) iconRes else android.R.drawable.ic_dialog_email)
            .setContentText("You replied: $replyText")
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(notificationId, ackNotification)
    }

    companion object {
        const val KEY_REPLY_TEXT = "geohub_dm_reply_text"
        const val EXTRA_CONVERSATION_ID = "geohub_conversation_id"
        const val EXTRA_TARGET_UID = "geohub_target_uid"
        const val EXTRA_NOTIFICATION_ID = "geohub_notification_id"
    }
}
