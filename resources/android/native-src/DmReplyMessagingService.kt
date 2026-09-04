package com.geohubmmc.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import com.google.firebase.messaging.RemoteMessage
import PLUGIN_MESSAGING_SERVICE_IMPORT

class DmReplyMessagingService : MessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data
        if (data["type"] != "dm") return
        showReplyNotification(data)
    }

    private fun showReplyNotification(data: Map<String, String>) {
        val context = applicationContext
        val conversationId = data["conversationId"] ?: return
        val senderUid = data["senderUid"] ?: return
        val notificationId = conversationId.hashCode()

        ensureChannel(context)

        val remoteInput = RemoteInput.Builder(DmReplyReceiver.KEY_REPLY_TEXT)
            .setLabel("Reply")
            .build()

        val replyIntent = Intent(context, DmReplyReceiver::class.java).apply {
            putExtra(DmReplyReceiver.EXTRA_CONVERSATION_ID, conversationId)
            putExtra(DmReplyReceiver.EXTRA_TARGET_UID, senderUid)
            putExtra(DmReplyReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        }
        val replyPendingIntent = PendingIntent.getBroadcast(
            context,
            notificationId,
            replyIntent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val replyAction = NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_send,
            "Reply",
            replyPendingIntent
        ).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build()

        val openIntent = Intent(context, MainActivity::class.java).apply {
            putExtra("geohub_url", data["url"] ?: "/#message")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val iconRes = context.resources.getIdentifier("ic_stat_notify", "drawable", context.packageName)
        val notification = NotificationCompat.Builder(context, DM_CHANNEL_ID)
            .setSmallIcon(if (iconRes != 0) iconRes else android.R.drawable.ic_dialog_email)
            .setContentTitle(data["title"] ?: "GeoHub")
            .setContentText(data["body"] ?: "")
            .setAutoCancel(true)
            .setContentIntent(openPendingIntent)
            .addAction(replyAction)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        NotificationManagerCompat.from(context).notify(notificationId, notification)
    }

    companion object {
        const val DM_CHANNEL_ID = "geohub_dm_channel"

        fun ensureChannel(context: android.content.Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(DM_CHANNEL_ID) != null) return
            val channel = NotificationChannel(DM_CHANNEL_ID, "Direct messages", NotificationManager.IMPORTANCE_HIGH)
            manager.createNotificationChannel(channel)
        }
    }
}
