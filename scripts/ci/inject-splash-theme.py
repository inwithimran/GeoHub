import re
import sys

path = "android/app/src/main/res/values/styles.xml"

with open(path, "r", encoding="utf-8") as f:
    text = f.read()

pattern = re.compile(
    r'<style(?=[^>]*\bname="AppTheme\.NoActionBarLaunch")(?=[^>]*\bparent="([^"]*)")[^>]*>.*?</style>',
    re.DOTALL
)

match = pattern.search(text)

if not match:
    print("Could not find AppTheme.NoActionBarLaunch style block", file=sys.stderr)
    print("---- styles.xml content ----", file=sys.stderr)
    print(text, file=sys.stderr)
    sys.exit(1)

parent = match.group(1)

replacement = (
    f'<style name="AppTheme.NoActionBarLaunch" parent="{parent}">'
    '<item name="windowSplashScreenBackground">#0f2e1d</item>'
    '<item name="windowSplashScreenAnimatedIcon">@drawable/splash</item>'
    '<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>'
    '</style>'
)

text = text[:match.start()] + replacement + text[match.end():]

with open(path, "w", encoding="utf-8") as f:
    f.write(text)

print("splash theme patched successfully")
