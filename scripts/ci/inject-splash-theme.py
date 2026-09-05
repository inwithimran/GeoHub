import os
import re
import shutil
import sys

styles_path = "android/app/src/main/res/values/styles.xml"
colors_path = "android/app/src/main/res/values/colors.xml"
asset_source = "resources/android/splash_icon.png"
asset_dest = "android/app/src/main/res/drawable/splash_icon.png"
layer_list_dest = "android/app/src/main/res/drawable/launch_background.xml"

shutil.copyfile(asset_source, asset_dest)

if os.path.exists(colors_path):
    with open(colors_path, "r", encoding="utf-8") as f:
        colors_text = f.read()
else:
    colors_text = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n'

if "geohuh_splash_background" not in colors_text:
    colors_text = colors_text.replace(
        "</resources>",
        '    <color name="geohuh_splash_background">#0f2e1d</color>\n</resources>',
        1
    )
    with open(colors_path, "w", encoding="utf-8") as f:
        f.write(colors_text)

with open(layer_list_dest, "w", encoding="utf-8") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <item android:drawable="@color/geohuh_splash_background" />\n'
        '    <item\n'
        '        android:width="140dp"\n'
        '        android:height="140dp"\n'
        '        android:gravity="center">\n'
        '        <bitmap\n'
        '            android:src="@drawable/splash_icon"\n'
        '            android:gravity="fill" />\n'
        '    </item>\n'
        '</layer-list>\n'
    )

with open(styles_path, "r", encoding="utf-8") as f:
    text = f.read()

pattern = re.compile(
    r'<style(?=[^>]*\bname="AppTheme\.NoActionBarLaunch")[^>]*>.*?</style>',
    re.DOTALL
)

match = pattern.search(text)

if not match:
    print("Could not find AppTheme.NoActionBarLaunch style block", file=sys.stderr)
    print("---- styles.xml content ----", file=sys.stderr)
    print(text, file=sys.stderr)
    sys.exit(1)

replacement = (
    '<style name="AppTheme.NoActionBarLaunch" parent="AppTheme.NoActionBar">'
    '<item name="android:windowBackground">@drawable/launch_background</item>'
    '</style>'
)

text = text[:match.start()] + replacement + text[match.end():]

with open(styles_path, "w", encoding="utf-8") as f:
    f.write(text)

print("splash theme patched successfully")
