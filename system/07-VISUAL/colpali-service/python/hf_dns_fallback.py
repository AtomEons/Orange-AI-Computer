"""Narrow DNS fallback for Hugging Face model downloads.

OrangeEye uses this only when Windows' configured resolver cannot resolve a
Hugging Face host. It leaves every other hostname and successful lookup alone.
"""

from __future__ import annotations

import os
import socket


def install() -> None:
    if os.environ.get("COLPALI_HF_DNS_FALLBACK", "1") != "1":
        return
    try:
        import dns.resolver  # type: ignore
    except ImportError:
        return

    original = socket.getaddrinfo
    resolver = dns.resolver.Resolver(configure=False)
    resolver.nameservers = [os.environ.get("COLPALI_DNS_SERVER", "1.1.1.1")]
    resolver.timeout = 3.0
    resolver.lifetime = 6.0

    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        try:
            return original(host, port, family, type, proto, flags)
        except socket.gaierror:
            name = str(host).lower()
            if not (name.endswith(".hf.co") or name == "huggingface.co"):
                raise
            answers = []
            for record_type, af in (("A", socket.AF_INET), ("AAAA", socket.AF_INET6)):
                if family not in (0, af):
                    continue
                try:
                    for answer in resolver.resolve(name, record_type):
                        answers.extend(original(str(answer), port, af, type, proto, flags))
                except Exception:
                    continue
            if not answers:
                raise
            return answers

    socket.getaddrinfo = getaddrinfo
