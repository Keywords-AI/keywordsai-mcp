#!/usr/bin/env python3
"""Regenerate lib/generated/manifest.json from the backend tool registry.

Run against a backend checkout, using its virtualenv:

    cd <respan-backend>
    ./.venv/bin/python <respan-mcp>/scripts/generate_manifest.py \
        --out <respan-mcp>/lib/generated/manifest.json

The tool surface (name, description, inputSchema) is copied verbatim from
`utils.mcp.tool_bridge.register_tools`, so this package and the in-product agent
cannot drift on contract.

Routes are DERIVED, not hand-written: each executor is invoked with the HTTP
layer stubbed and unique sentinel arguments, and the request it would have made
is inspected to learn where every argument belongs. A tool is only registered
when every one of its arguments was located. Anything unresolved is emitted with
route=null plus a reason and stays unregistered, so a tool is never wired to a
guessed endpoint.
"""

import json
import re
import os
import sys

sys.path.insert(0, os.getcwd())
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "keywordsai.settings")
import django  # noqa: E402

django.setup()

OUT_PATH = "lib/generated/manifest.json"
if "--out" in sys.argv:
    OUT_PATH = sys.argv[sys.argv.index("--out") + 1]

from admin.mcp_server import core  # noqa: E402
from utils.mcp.tool_bridge import (  # noqa: E402
    AGENT_READ_ONLY_TOOLS,
    AGENT_SAFE_DOMAINS,
    ALL_DOMAIN_REGISTRY,
    _ensure_registry,
    register_tools,
)

_ensure_registry()
ACTIVITY = core.TOOL_ACTIVITY_PARAM_KEY
JWT_ONLY = {
    "org_get": "endpoint requires interactive (JWT) authentication",
    "org_subscription_get": "endpoint requires interactive (JWT) authentication",
    "org_member_list": "endpoint requires interactive (JWT) authentication",
    "oauth_resource_list": "endpoint requires interactive (JWT) authentication",
}


class _Cap(Exception):
    def __init__(self, method, path, params, data):
        self.r = {"method": method, "path": path, "params": params, "data": data}


def _verb(method, is_body):
    # Mirror HTTPClient exactly: get/delete take `params`, post/patch/put take `data`.
    if is_body:

        def call(self, path, data=None):
            raise _Cap(method, path, None, data)

    else:

        def call(self, path, params=None):
            raise _Cap(method, path, params, None)

    return call


core.HTTPClient.get = _verb("GET", False)
core.HTTPClient.delete = _verb("DELETE", False)
core.HTTPClient.post = _verb("POST", True)
core.HTTPClient.patch = _verb("PATCH", True)
core.HTTPClient.put = _verb("PUT", True)

tools, _ = register_tools(sorted(AGENT_SAFE_DOMAINS, key=str), client=None)
schemas = {t["function"]["name"]: t["function"]["parameters"] for t in tools}
descs = {t["function"]["name"]: t["function"]["description"] for t in tools}
execs = {}
for _dom, (dts, ex) in ALL_DOMAIN_REGISTRY.items():
    for t in dts:
        if t.name in schemas:
            execs.setdefault(t.name, ex)


def token(key):
    return f"ZZ{key.replace('_', '')}ZZ"


def value(key, spec):
    typ = spec.get("type")
    if isinstance(typ, list):
        typ = next((t for t in typ if t != "null"), "string")
    if "enum" in spec and spec["enum"]:
        return spec["enum"][0]
    if typ == "integer":
        return 4242
    if typ == "number":
        return 42.5
    if typ == "boolean":
        return True
    if typ == "array":
        it = (spec.get("items") or {}).get("type")
        return [4242] if it in ("integer", "number") else [token(key)]
    if typ == "object":
        return {token(key): token(key)}
    return token(key)


def find(tok, req):
    """Return where the token appears: path / query.<k> / body.<path>."""
    out = []
    # Executors append the built query string onto the path, so the two have to
    # be separated here or a pagination arg looks like a URL segment.
    raw_path, _, raw_qs = (req["path"] or "").partition("?")
    if tok in raw_path:
        out.append("path")
    if raw_qs:
        from urllib.parse import parse_qs

        for qkey, qvals in parse_qs(raw_qs, keep_blank_values=True).items():
            if any(tok in str(v) for v in qvals):
                out.append(f"query.{qkey}")
    for label, blob in (("query", req["params"]), ("body", req["data"])):
        if not isinstance(blob, dict):
            continue

        def walk(node, trail):
            if isinstance(node, dict):
                for k, v in node.items():
                    if isinstance(k, str) and tok in k:
                        out.append(f"{label}.{'.'.join(trail + ['<key>'])}")
                    walk(v, trail + [str(k)])
            elif isinstance(node, list):
                for v in node:
                    walk(v, trail)
            elif isinstance(node, str) and tok in node:
                out.append(f"{label}.{'.'.join(trail)}")

        walk(blob, [])
    return sorted(set(out))


def invoke(name, args):
    try:
        execs[name](name=name, args=args, client=CLIENT, profile="local")
        return None, "no HTTP call"
    except _Cap as cap:
        return cap.r, None
    except Exception as exc:
        return None, f"{type(exc).__name__}: {str(exc)[:70]}"


CLIENT = core.HTTPClient(api_key="k", base_url="http://h")
spec, unresolved = {}, {}

for name in sorted(schemas):
    if name in JWT_ONLY or name not in execs:
        unresolved[name] = "excluded (jwt-only)" if name in JWT_ONLY else "no executor"
        continue
    props = schemas[name].get("properties", {})
    required = [k for k in schemas[name].get("required", []) if k != ACTIVITY]
    base_args = {k: value(k, props[k]) for k in required if k in props}
    # The executors read the activity label when building the response envelope,
    # so it must be present even though it is never forwarded upstream.
    if ACTIVITY in props:
        base_args[ACTIVITY] = "activity label"
    req, err = invoke(name, dict(base_args))
    if req is None:
        unresolved[name] = err
        continue

    arg_map = {}
    for k in required:
        if k in props:
            hits = find(token(k), req) if isinstance(value(k, props[k]), str) else []
            arg_map[k] = hits or ["?"]

    for k in props:
        if k in base_args or k == ACTIVITY:
            continue
        probe = dict(base_args)
        probe[k] = value(k, props[k])
        r2, _e2 = invoke(name, probe)
        if r2 is None:
            continue
        v = value(k, props[k])
        hits = find(token(k), r2) if isinstance(v, str) else []
        if not hits and isinstance(v, (int, float, bool)):
            hits = find(str(v), r2)
        if hits:
            arg_map[k] = hits

    spec[name] = {
        "description_len": len(descs[name]),
        "method": req["method"],
        "path_template": req["path"].split("?")[0],
        "sends_body": req["data"] is not None,
        "arg_map": arg_map,
        "unmapped_args": sorted(set(props) - set(arg_map) - {ACTIVITY}),
    }

SPEC = spec
print(f"resolved {len(spec)} / {len(schemas)} tools")
fully = [n for n, v in spec.items() if not v["unmapped_args"]]
print(f"  of those, every argument mapped: {len(fully)}")
print(f"unresolved: {len(unresolved)}")
byreason = {}
for why in unresolved.values():
    byreason[why.split(":")[0]] = byreason.get(why.split(":")[0], 0) + 1
print("reasons:", byreason)



# ---- public-surface sanitisation ----
# Descriptions are authored for an internal tool registry and reference private
# repository paths, source files, and staff-only behaviour. This package is a
# PUBLIC repository serving a PUBLIC endpoint, so that text must not travel with
# them. Sentences matching these patterns are dropped from every description.
_INTERNAL_PATTERNS = (
    # Any repository-relative file path: internal docs and source alike. Kept
    # generic on purpose so this list does not itself name private directories.
    re.compile(r"\b[\w.-]+/[\w./-]*\.(?:md|py)\b"),
    re.compile(r"superadmin", re.IGNORECASE),
    re.compile(r"\bstaff[- _]only\b", re.IGNORECASE),
)


# Tool names that appear in backend descriptions but exist on no published
# surface. Left alone they instruct a client to call something that is not
# there, which reads as a broken server rather than a stale sentence.
#
# A rename is rewritten. A reference to an internal-only mechanism, or to a tool
# that exists nowhere, has its sentence dropped by _DANGLING_TOOL_SENTENCES.
_RENAMED_TOOL_REFERENCES = {}

# Sentences mentioning these are dropped wholesale: there is no correct
# replacement to point a caller at.
_DANGLING_TOOL_SENTENCES = (
    # The in-product agent loads tools on demand through this; no client-facing
    # equivalent exists, so the instruction cannot be followed here.
    re.compile(r"\btool_search\b"),
    # evaluator_run_now points at this to cancel or resume a run, but the op is
    # not in the agent registry, so no surface publishes it. Reported upstream;
    # drop this rule once the backend description stops naming it.
    re.compile(r"\bevaluator_run_update\b"),
    # Withheld from this surface (see verify-agent-parity.mjs), so the sentence
    # telling a caller to resolve OAuth channel ids with it cannot be followed.
    # No guidance is lost: that endpoint is JWT-only, so the OAuth channel shape
    # was never reachable under an API key, and the webhook_url shape those
    # descriptions document alongside it still is.
    re.compile(r"\boauth_resource_list\b"),
    # Withheld from this surface (see verify-agent-parity.mjs). Sibling prompt
    # descriptions point at it as the recovery path; that path is the web app
    # here. The sentences dropped alongside it only name the discovery trick,
    # which prompt_list's own is_deleted argument already documents.
    re.compile(r"\bprompt_trash_restore\b"),
)


def _sentences(text: str) -> list:
    """Split on sentence and bullet boundaries, keeping the separators."""
    return re.split(r"(?<=[.!?])\s+|\n", text)


def scrub_internal(text: str) -> str:
    """Drop any sentence naming internal infrastructure or an absent tool."""
    if not text:
        return text
    for stale, current in _RENAMED_TOOL_REFERENCES.items():
        text = re.sub(rf"\b{re.escape(stale)}\b", current, text)
    kept = [
        part
        for part in _sentences(text)
        if not any(pattern.search(part) for pattern in _INTERNAL_PATTERNS)
        and not any(pattern.search(part) for pattern in _DANGLING_TOOL_SENTENCES)
    ]
    cleaned = " ".join(part.strip() for part in kept if part.strip())
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def assert_clean(manifest_blob: str) -> None:
    """Fail generation outright rather than publish an internal reference."""
    offenders = sorted(
        {
            match.group(0)
            for pattern in _INTERNAL_PATTERNS
            for match in pattern.finditer(manifest_blob)
        }
    )
    if offenders:
        raise SystemExit(
            "refusing to write manifest, internal references present: "
            + ", ".join(offenders)
        )

# ---- manifest assembly ----
ACTIVITY = core.TOOL_ACTIVITY_PARAM_KEY


# Backed by JWT-only endpoints. A customer API key cannot authenticate these,
# so they are excluded from the public package rather than shipped broken.
JWT_ONLY = {
    "org_get": "endpoint requires interactive (JWT) authentication",
    "org_subscription_get": "endpoint requires interactive (JWT) authentication",
    "org_member_list": "endpoint requires interactive (JWT) authentication",
    "oauth_resource_list": "endpoint requires interactive (JWT) authentication",
}

# Known to fail under API-key authentication for some keys. Tracked upstream;
# excluded until fixed rather than shipped as an intermittent 500.
APIKEY_WRITE_UNSAFE = {
    f"{noun}_{op}"
    for noun in ("monitor", "automation", "report", "evaluator")
    for op in ("update", "commit", "version_create")
}

spec = SPEC
tools, _ = register_tools(sorted(AGENT_SAFE_DOMAINS, key=str), client=None)

out = []
for t in sorted(tools, key=lambda x: x["function"]["name"]):
    fn = t["function"]
    name = fn["name"]
    schema = json.loads(json.dumps(fn["parameters"]))
    # The activity label drives an in-product UI affordance the public server
    # does not have, and it is never forwarded upstream.
    schema.get("properties", {}).pop(ACTIVITY, None)
    if ACTIVITY in schema.get("required", []):
        schema["required"] = [r for r in schema["required"] if r != ACTIVITY]

    for _prop in schema.get("properties", {}).values():
        if isinstance(_prop, dict) and isinstance(_prop.get("description"), str):
            _prop["description"] = scrub_internal(_prop["description"])

    entry = {
        "name": name,
        "description": scrub_internal(fn["description"]),
        "inputSchema": schema,
        "readOnly": name in AGENT_READ_ONLY_TOOLS,
        "route": None,
        "excluded": None,
    }
    if name in JWT_ONLY:
        entry["excluded"] = f"jwt-only: {JWT_ONLY[name]}"
    elif name in APIKEY_WRITE_UNSAFE:
        entry["excluded"] = (
            "write path is unreliable under API-key authentication; "
            "tracked upstream"
        )
    elif name in spec:
        s = spec[name]
        # "?" means the sentinel never surfaced in the request, so the argument's
        # destination is unknown. Shipping it would be a guess.
        unknown = sorted(k for k, v in s["arg_map"].items() if "?" in v)
        s["unmapped_args"] = sorted(set(s["unmapped_args"]) | set(unknown))
        if s["unmapped_args"]:
            entry["excluded"] = (
                "route verified but "
                f"{len(s['unmapped_args'])} argument(s) unmapped: {', '.join(s['unmapped_args'])}"
            )
        else:
            entry["route"] = {
                "method": s["method"],
                "path": s["path_template"],
                "sendsBody": s["sends_body"],
                "argMap": {k: v for k, v in s["arg_map"].items() if k != ACTIVITY},
            }
    else:
        entry["excluded"] = "route not machine-verified; needs a hand-written spec"
    out.append(entry)

registered = [e for e in out if e["route"]]
manifest = {
    "generatedFrom": "backend utils/mcp/tool_bridge.register_tools(AGENT_SAFE_DOMAINS)",
    "toolCount": len(out),
    "registeredCount": len(registered),
    "tools": out,
}
dest = OUT_PATH
assert_clean(json.dumps(manifest))
json.dump(manifest, open(dest, "w"), indent=1)

print(f"tools in manifest      : {len(out)}")
print(f"  registered (routable): {len(registered)}")
print(f"  read-only of those   : {sum(1 for e in registered if e['readOnly'])}")
reasons = {}
for e in out:
    if e["excluded"]:
        k = e["excluded"].split(":")[0].split(";")[0][:44]
        reasons[k] = reasons.get(k, 0) + 1
print("held back:")
for k, v in sorted(reasons.items(), key=lambda x: -x[1]):
    print(f"  {v:3d}  {k}")
print(f"manifest bytes: {os.path.getsize(dest)}")
