import re
import sys

path = "android/app/src/main/res/values/styles.xml"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

pattern = re.compile(
    r'<style name="AppTheme\.NoActionBarLaunch" parent="@style/Theme\.SplashScreen">.*?</style>',
    re.DOTALL
)

replacement = (
    '<style name="AppTheme.NoActionBarLaunch" parent="@style/Theme.SplashScreen">'
    '<item name="windowSplashScreenBackground">#0f2e1d</item>'
    '<item name="windowSplashScreenAnimatedIcon">@drawable/splash</item>'
    '<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>'
    '</style>'
)

text, count = pattern.subn(replacement, text)

if count == 0:
    print("Could not find AppTheme.NoActionBarLaunch style block", file=sys.stderr)
    sys.exit(1)

with open(path, "w", encoding="utf-8") as f:
    f.write(text)

print("splash theme patched successfully")
