import sys

path = "android/variables.gradle"

with open(path, "r") as f:
    text = f.read()

if "rgcfaIncludeGoogle" in text:
    sys.exit(0)

marker = "ext {"
if marker not in text:
    print("Could not find 'ext {' block in variables.gradle", file=sys.stderr)
    sys.exit(1)

addition = "ext {\n    rgcfaIncludeGoogle = true\n    androidxCredentialsVersion = '1.3.0'\n"
text = text.replace(marker, addition, 1)

with open(path, "w") as f:
    f.write(text)

print("android variables injected successfully")
