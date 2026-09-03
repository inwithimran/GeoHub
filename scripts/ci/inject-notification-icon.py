import re
import shutil
import sys

manifest_path = "android/app/src/main/AndroidManifest.xml"
colors_path = "android/app/src/main/res/values/notification_colors.xml"
source_dir = "resources/android/notification-icon"
densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]

for density in densities:
    dest_dir = f"android/app/src/main/res/drawable-{density}"
    shutil.copyfile(f"{source_dir}/{density}.png", f"{dest_dir}/ic_stat_notify.png")

with open(colors_path, "w") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        '    <color name="notification_icon_color">#1a4c30</color>\n'
        "</resources>\n"
    )

with open(manifest_path, "r") as f:
    manifest = f.read()

if "com.google.firebase.messaging.default_notification_icon" not in manifest:
    meta_data = (
        '        <meta-data android:name="com.google.firebase.messaging.default_notification_icon" '
        'android:resource="@drawable/ic_stat_notify" />\n'
        '        <meta-data android:name="com.google.firebase.messaging.default_notification_color" '
        'android:resource="@color/notification_icon_color" />\n'
    )
    manifest = re.sub(
        r"(<application[^>]*>)",
        r"\1\n" + meta_data,
        manifest,
        count=1,
    )
    with open(manifest_path, "w") as f:
        f.write(manifest)

print("notification icon injected successfully")
