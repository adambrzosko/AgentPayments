from django.urls import path, re_path

from . import views

urlpatterns = [
    path("__challenge/verify", views.challenge_verify, name="challenge_verify"),
    path("robots.txt", views.serve_robots_txt, name="robots_txt"),
    path(".well-known/agent-access.json", views.serve_agent_access_json, name="agent_access_json"),
    re_path(r"^.*$", views.serve_index, name="catch_all"),
]
