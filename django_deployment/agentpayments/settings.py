import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

def _csv_env(name: str, default: str = ""):
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


SECRET_KEY = os.environ.get(
    "DJANGO_SECRET_KEY", "django-insecure-change-me-in-production"
)

DEBUG = os.environ.get("DEBUG", "true").lower() != "false"

ALLOWED_HOSTS = _csv_env("ALLOWED_HOSTS", "127.0.0.1,localhost")
CSRF_TRUSTED_ORIGINS = _csv_env("CSRF_TRUSTED_ORIGINS")
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "gate",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "gate.middleware.GateMiddleware",
]

ROOT_URLCONF = "agentpayments.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
            ],
        },
    },
]

WSGI_APPLICATION = "agentpayments.wsgi.application"

DATABASES = {}

STATIC_URL = "/static/"
STATICFILES_DIRS = [BASE_DIR / "static"]

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- AgentPayments gate configuration ---
CHALLENGE_SECRET = os.environ.get("CHALLENGE_SECRET", "default-secret-change-me")
HOME_WALLET_ADDRESS = os.environ.get("HOME_WALLET_ADDRESS", "")
SOLANA_RPC_URL = os.environ.get("SOLANA_RPC_URL", "")
USDC_MINT = os.environ.get("USDC_MINT", "")
