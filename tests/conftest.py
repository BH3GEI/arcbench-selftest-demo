import os

# Tests exercise the dev-mode auth path (any token string is its own team).
os.environ.setdefault("SELFTEST_ALLOW_ANY_TOKEN", "1")
