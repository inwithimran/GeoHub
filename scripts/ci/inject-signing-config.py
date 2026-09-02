import pathlib
import sys

path = pathlib.Path("android/app/build.gradle")
text = path.read_text()

signing_block = """android {
    signingConfigs {
        release {
            storeFile file("release.keystore")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
    }
"""

if "signingConfigs {" in text:
    sys.exit(0)

new_text, count = text.replace("android {\n", signing_block, 1), text.count("android {\n")
if count == 0:
    print("Could not find 'android {' block in build.gradle", file=sys.stderr)
    sys.exit(1)
text = new_text

marker = "release {\n            minifyEnabled"
replacement = "release {\n            signingConfig signingConfigs.release\n            minifyEnabled"
if marker not in text:
    print("Could not find release buildType block in build.gradle", file=sys.stderr)
    sys.exit(1)
text = text.replace(marker, replacement, 1)

path.write_text(text)
