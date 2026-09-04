import re
import sys

path = "android/variables.gradle"

with open(path, "r") as f:
    text = f.read()

if "rgcfaIncludeGoogle" not in text:
    marker = "ext {"
    if marker not in text:
        print("Could not find 'ext {' block in variables.gradle", file=sys.stderr)
        sys.exit(1)
    addition = "ext {\n    rgcfaIncludeGoogle = true\n    androidxCredentialsVersion = '1.3.0'\n"
    text = text.replace(marker, addition, 1)

text, count = re.subn(
    r"minSdkVersion\s*=\s*\d+",
    "minSdkVersion = 23",
    text,
)
if count == 0:
    print("Could not find minSdkVersion in variables.gradle", file=sys.stderr)
    sys.exit(1)

with open(path, "w") as f:
    f.write(text)

print("android variables injected successfully")
