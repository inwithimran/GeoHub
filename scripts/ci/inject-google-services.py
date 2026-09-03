import re
import sys

project_gradle_path = "android/build.gradle"
app_gradle_path = "android/app/build.gradle"

with open(project_gradle_path, "r") as f:
    project_gradle = f.read()

if "com.google.gms:google-services" not in project_gradle:
    project_gradle = project_gradle.replace(
        "dependencies {",
        "dependencies {\n        classpath 'com.google.gms:google-services:4.4.2'",
        1
    )
    with open(project_gradle_path, "w") as f:
        f.write(project_gradle)

with open(app_gradle_path, "r") as f:
    app_gradle = f.read()

if "com.google.gms.google-services" not in app_gradle:
    app_gradle += "\napply plugin: 'com.google.gms.google-services'\n"
    with open(app_gradle_path, "w") as f:
        f.write(app_gradle)

print("google-services plugin injected successfully")
