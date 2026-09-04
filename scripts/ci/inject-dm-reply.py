import os
import re
import shutil
import sys

PACKAGE_PATH = "com/geohubmmc/app"

PLUGIN_SOURCE_ROOT = "node_modules/@capacitor-firebase/messaging/android/src/main/java"
CLASS_DECL_RE = re.compile(r"class\s+(\w+)\s*(?:extends|:)\s*FirebaseMessagingService\b")
PACKAGE_DECL_RE = re.compile(r"^\s*package\s+([\w.]+)\s*;?\s*$", re.MULTILINE)


def find_plugin_messaging_service():
    if not os.path.isdir(PLUGIN_SOURCE_ROOT):
        print(f"Could not find {PLUGIN_SOURCE_ROOT} (is @capacitor-firebase/messaging installed?)", file=sys.stderr)
        sys.exit(1)
    for dirpath, _, filenames in os.walk(PLUGIN_SOURCE_ROOT):
        for filename in filenames:
            if not (filename.endswith(".java") or filename.endswith(".kt")):
                continue
            path = os.path.join(dirpath, filename)
            with open(path, "r") as f:
                content = f.read()
            class_match = CLASS_DECL_RE.search(content)
            package_match = PACKAGE_DECL_RE.search(content)
            if class_match and package_match:
                return f"{package_match.group(1)}.{class_match.group(1)}"
    print(f"Could not find a FirebaseMessagingService subclass under {PLUGIN_SOURCE_ROOT}", file=sys.stderr)
    sys.exit(1)


PLUGIN_SERVICE_NAME = find_plugin_messaging_service()
print(f"Detected plugin messaging service: {PLUGIN_SERVICE_NAME}")

kt_source_dir = "resources/android/native-src"
kt_dest_dir = f"android/app/src/main/java/{PACKAGE_PATH}"
manifest_path = "android/app/src/main/AndroidManifest.xml"
project_gradle_path = "android/build.gradle"
app_gradle_path = "android/app/build.gradle"

os.makedirs(kt_dest_dir, exist_ok=True)
old_main_activity = f"{kt_dest_dir}/MainActivity.java"
if os.path.exists(old_main_activity):
    os.remove(old_main_activity)
for filename in os.listdir(kt_source_dir):
    if not filename.endswith(".kt"):
        continue
    src_path = f"{kt_source_dir}/{filename}"
    dest_path = f"{kt_dest_dir}/{filename}"
    if filename == "DmReplyMessagingService.kt":
        with open(src_path, "r") as f:
            content = f.read()
        content = content.replace(
            "import PLUGIN_MESSAGING_SERVICE_IMPORT",
            f"import {PLUGIN_SERVICE_NAME} as MessagingService",
            1,
        )
        with open(dest_path, "w") as f:
            f.write(content)
    else:
        shutil.copyfile(src_path, dest_path)

with open(project_gradle_path, "r") as f:
    project_gradle = f.read()

if "kotlin_version" not in project_gradle:
    project_gradle = project_gradle.replace(
        "buildscript {",
        "buildscript {\n    ext.kotlin_version = '1.9.24'",
        1
    )
if "org.jetbrains.kotlin:kotlin-gradle-plugin" not in project_gradle:
    project_gradle = project_gradle.replace(
        "dependencies {",
        "dependencies {\n        classpath \"org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version\"",
        1
    )
with open(project_gradle_path, "w") as f:
    f.write(project_gradle)

with open(app_gradle_path, "r") as f:
    app_gradle = f.read()

if "kotlin-android" not in app_gradle:
    app_gradle = app_gradle.replace(
        "apply plugin: 'com.android.application'",
        "apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'",
        1
    )
if "com.google.firebase:firebase-auth" not in app_gradle:
    app_gradle = app_gradle.replace(
        "dependencies {",
        "dependencies {\n    implementation platform(\"com.google.firebase:firebase-bom:33.1.2\")\n    implementation \"com.google.firebase:firebase-auth\"\n    implementation \"androidx.work:work-runtime-ktx:2.9.1\"\n    implementation \"org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3\"",
        1
    )
with open(app_gradle_path, "w") as f:
    f.write(app_gradle)

with open(manifest_path, "r") as f:
    manifest = f.read()

if "DmReplyMessagingService" in manifest:
    print("dm reply already injected")
    sys.exit(0)

if 'xmlns:tools=' not in manifest:
    manifest = re.sub(
        r"(<manifest[^>]*)(>)",
        r'\1 xmlns:tools="http://schemas.android.com/tools"\2',
        manifest,
        count=1
    )

components = (
    f'        <service android:name="{PLUGIN_SERVICE_NAME}" tools:node="remove" />\n'
    '        <service android:name=".DmReplyMessagingService" android:exported="false">\n'
    '            <intent-filter>\n'
    '                <action android:name="com.google.firebase.MESSAGING_EVENT" />\n'
    '            </intent-filter>\n'
    '        </service>\n'
    '        <receiver android:name=".DmReplyReceiver" android:exported="false" />\n'
)

manifest = manifest.replace("</application>", components + "    </application>", 1)

with open(manifest_path, "w") as f:
    f.write(manifest)

print("dm reply injected successfully")
