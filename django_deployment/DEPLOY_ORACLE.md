# Oracle Always Free Deployment (Django)

This project can run on a single Oracle Linux/Ubuntu VM with `gunicorn` + `nginx`.

## 1) Create VM and open ports

1. Create an Always Free VM in Oracle Cloud (Ampere A1 works well).
2. In Oracle VCN security list and/or NSG, allow inbound:
   - `22` (SSH)
   - `80` (HTTP)
   - `443` (HTTPS, if you add TLS)

## 2) Install system packages

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip nginx git
```

## 3) Clone and install app

```bash
sudo mkdir -p /opt/agentpayments
sudo chown -R $USER:$USER /opt/agentpayments
cd /opt/agentpayments
git clone <YOUR_REPO_URL> .
python3 -m venv /opt/agentpayments/.venv
source /opt/agentpayments/.venv/bin/activate
pip install --upgrade pip
pip install -r django_deployment/requirements.txt
```

## 4) Configure environment

```bash
cp /opt/agentpayments/django_deployment/.env.example /opt/agentpayments/django_deployment/.env
```

Edit `django_deployment/.env`:

```dotenv
DEBUG=false
DJANGO_SECRET_KEY=<strong-random-secret>
CHALLENGE_SECRET=<strong-random-secret>
HOME_WALLET_ADDRESS=<your-wallet>
SOLANA_RPC_URL=
USDC_MINT=
ALLOWED_HOSTS=<your-domain-or-public-ip>
CSRF_TRUSTED_ORIGINS=http://<your-domain-or-public-ip>
```

If you later add TLS, set `CSRF_TRUSTED_ORIGINS` to `https://...`.

## 5) Validate Django config

```bash
source /opt/agentpayments/.venv/bin/activate
python3 /opt/agentpayments/django_deployment/manage.py check
```

## 6) Install systemd service

```bash
sudo cp /opt/agentpayments/django_deployment/deploy/oracle/agentpayments.service /etc/systemd/system/agentpayments.service
sudo systemctl daemon-reload
sudo systemctl enable --now agentpayments
sudo systemctl status agentpayments --no-pager
```

## 7) Configure nginx

```bash
sudo cp /opt/agentpayments/django_deployment/deploy/oracle/nginx-agentpayments.conf /etc/nginx/sites-available/agentpayments
sudo ln -sf /etc/nginx/sites-available/agentpayments /etc/nginx/sites-enabled/agentpayments
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

## 8) Verify

```bash
curl -i http://<server-ip>/
curl -i http://<server-ip>/.well-known/agent-access.json
```

## Optional: HTTPS (recommended)

Use Caddy or Certbot + nginx once you point a domain at the VM.
