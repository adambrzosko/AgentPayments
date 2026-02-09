from pathlib import Path

from django.conf import settings
from django.http import HttpResponse

from agentpayments_python.django_adapter import challenge_verify

STATIC_DIR = Path(settings.BASE_DIR) / "static"


def serve_index(request):
    index_path = STATIC_DIR / "index.html"
    try:
        content = index_path.read_text()
    except FileNotFoundError:
        return HttpResponse("Not found", status=404)
    return HttpResponse(content, content_type="text/html")


def serve_robots_txt(request):
    robots_path = STATIC_DIR / "robots.txt"
    try:
        content = robots_path.read_text()
    except FileNotFoundError:
        return HttpResponse("Not found", status=404)
    return HttpResponse(content, content_type="text/plain")


def serve_agent_access_json(request):
    json_path = STATIC_DIR / ".well-known" / "agent-access.json"
    try:
        content = json_path.read_text()
    except FileNotFoundError:
        return HttpResponse("Not found", status=404)
    return HttpResponse(content, content_type="application/json")
