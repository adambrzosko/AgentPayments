# agentpayments-python (local SDK package)

Python adapters for AgentPayments gate.

## Adapters
- Django: `agentpayments_python.django_adapter`
- FastAPI/Starlette: `agentpayments_python.fastapi_adapter`
- Flask: `agentpayments_python.flask_adapter`

## Django usage
```python
# settings.py
MIDDLEWARE = [
  "django.middleware.security.SecurityMiddleware",
  "agentpayments_python.django_adapter.GateMiddleware",
]

CHALLENGE_SECRET = os.environ.get("CHALLENGE_SECRET", "default-secret-change-me")
AGENTPAYMENTS_VERIFY_URL = os.environ.get("AGENTPAYMENTS_VERIFY_URL", "")
AGENTPAYMENTS_API_KEY = os.environ.get("AGENTPAYMENTS_API_KEY", "")
```

## FastAPI usage
```python
from fastapi import FastAPI, Request
from agentpayments_python.fastapi_adapter import AgentPaymentsASGIMiddleware, challenge_verify_endpoint

app = FastAPI()
app.add_middleware(
    AgentPaymentsASGIMiddleware,
    challenge_secret="...",
    verify_url="https://...",
    gate_api_secret="vk_...",
)

@app.post('/__challenge/verify')
async def verify(request: Request):
    return await challenge_verify_endpoint(request, challenge_secret="...")
```

## Flask usage
```python
from flask import Flask
from agentpayments_python.flask_adapter import register_agentpayments

app = Flask(__name__)
register_agentpayments(app, challenge_secret="...", verify_url="https://...", gate_api_secret="vk_...")
```

Wallet address and network are fetched automatically from the verify service.
