"""Memory ID selectors must not become URL syntax at the HTTP boundary."""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from memoria._http import _HttpTransport
from memoria.exceptions import MemoriaServerError
from memoria.resources.memories import AsyncMemoriesResource, MemoriesResource

# Literal expected wire encodings, independent of the production helper.
SELECTORS = [
    ("b616be586e5a469183ba98c6c5da002f", "b616be586e5a469183ba98c6c5da002f"),
    ("../branches/release", "..%2Fbranches%2Frelease"),
    ("../snapshots/backup", "..%2Fsnapshots%2Fbackup"),
    ("target?branch=other", "target%3Fbranch%3Dother"),
    ("target#fragment", "target%23fragment"),
    ("literal%2Fid", "literal%252Fid"),
    ("part/child", "part%2Fchild"),
    (".", "%2E"),
    ("..", "%2E%2E"),
    ("\u7f16\u53f7", "%E7%BC%96%E5%8F%B7"),
]
METHODS = {
    "correct": ("PUT", "/correct"),
    "delete": ("DELETE", ""),
    "feedback": ("POST", "/feedback"),
}


def arguments(operation: str) -> dict[str, str]:
    if operation == "correct":
        return {"new_content": "corrected", "reason": "fix", "branch": "scope"}
    if operation == "delete":
        return {"reason": "cleanup", "branch": "scope"}
    return {"signal": "useful", "context": "same context"}


def handler_for(operation: str, encoded: str) -> Callable[[httpx.Request], httpx.Response]:
    method, suffix = METHODS[operation]
    expected_path = f"/v1/memories/{encoded}{suffix}".encode("ascii")

    def handle(request: httpx.Request) -> httpx.Response:
        assert request.method == method
        assert request.url.raw_path.split(b"?", 1)[0] == expected_path
        assert request.url.fragment == ""
        assert request.headers["authorization"] == "Bearer synthetic-test-key"
        if operation == "delete":
            assert dict(request.url.params) == {"reason": "cleanup", "branch": "scope"}
        else:
            assert dict(request.url.params) == {}
            assert json.loads(request.content) == arguments(operation)
        if operation == "correct":
            return httpx.Response(200, json={"memory_id": "replacement", "content": "corrected"})
        return httpx.Response(204)

    return handle


@pytest.mark.parametrize("selector,encoded", SELECTORS)
@pytest.mark.parametrize("operation", METHODS)
def test_sync_memory_selector_stays_one_segment(selector, encoded, operation):
    owner = _HttpTransport("https://memoria.test", "synthetic-test-key", max_retries=0)
    with httpx.Client(
        transport=httpx.MockTransport(handler_for(operation, encoded)), headers=owner._headers
    ) as http:
        owner._http = http
        resource = MemoriesResource(owner)
        result = getattr(resource, operation)(selector, **arguments(operation))
        if operation == "correct":
            assert result.memory_id == "replacement"
            assert result.content == "corrected"
        else:
            assert result is None


@pytest.mark.asyncio
@pytest.mark.parametrize("selector,encoded", SELECTORS)
@pytest.mark.parametrize("operation", METHODS)
async def test_async_memory_selector_stays_one_segment(selector, encoded, operation):
    owner = _HttpTransport("https://memoria.test", "synthetic-test-key", max_retries=0)
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler_for(operation, encoded)), headers=owner._headers
    ) as http:
        owner._ahttp = http
        resource = AsyncMemoriesResource(owner)
        result = await getattr(resource, operation)(selector, **arguments(operation))
        if operation == "correct":
            assert result.memory_id == "replacement"
            assert result.content == "corrected"
        else:
            assert result is None


def test_correction_is_not_replayed_after_server_failure():
    requests = []

    def fail(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(503, json={"detail": "possibly committed"})

    owner = _HttpTransport("https://memoria.test", "synthetic-test-key", max_retries=2)
    with httpx.Client(transport=httpx.MockTransport(fail)) as http:
        owner._http = http
        with pytest.raises(MemoriaServerError):
            MemoriesResource(owner).correct("normal-id", new_content="corrected")
    assert [r.url.raw_path for r in requests] == [b"/v1/memories/normal-id/correct"]


@pytest.mark.asyncio
async def test_async_correction_is_not_replayed_after_server_failure():
    requests = []

    def fail(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(503, json={"detail": "possibly committed"})

    owner = _HttpTransport("https://memoria.test", "synthetic-test-key", max_retries=2)
    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as http:
        owner._ahttp = http
        with pytest.raises(MemoriaServerError):
            await AsyncMemoriesResource(owner).correct("normal-id", new_content="corrected")
    assert [r.url.raw_path for r in requests] == [b"/v1/memories/normal-id/correct"]
