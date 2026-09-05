import re
import shutil
import sys

styles_path = "android/app/src/main/res/values/styles.xml"
asset_source = "resources/android/splash_icon.png"
asset_dest = "android/app/src/main/res/drawable/splash_icon.png"

shutil.copyfile(asset_source, asset_dest)

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
    '<style name="AppTheme.NoActionBarLaunch" parent="@style/Theme.SplashScreen.IconBackground">'
    '<item name="windowSplashScreenBackground">#0f2e1d</item>'
    '<item name="windowSplashScreenAnimatedIcon">@drawable/splash_icon</item>'
    '<item name="windowSplashScreenIconBackgroundColor">#0f2e1d</item>'
    '<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>'
    '</style>'
)

text = text[:match.start()] + replacement + text[match.end():]

with open(styles_path, "w", encoding="utf-8") as f:
    f.write(text)

print("splash theme patched successfully")
