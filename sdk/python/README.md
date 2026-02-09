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
```

## FastAPI usage
```python
from fastapi import FastAPI, Request
from agentpayments_python.fastapi_adapter import AgentPaymentsASGIMiddleware, challenge_verify_endpoint

app = FastAPI()
app.add_middleware(
    AgentPaymentsASGIMiddleware,
    challenge_secret="...",
    home_wallet_address="...",
    debug=True,
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
register_agentpayments(app, challenge_secret="...", home_wallet_address="...", debug=True)
```
