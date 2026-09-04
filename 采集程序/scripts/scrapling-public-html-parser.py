#!/usr/bin/env python3
"""Parse already-fetched, allowlisted public HTML with Scrapling.

This helper never opens URLs, launches browsers, uses proxies, or handles login
state. Node owns network policy, DNS checks, redirects, rate limits, and size
limits; this process only receives one HTML document over stdin.
"""
from __future__ import annotations

import json
import sys
from typing import Any

from scrapling import Selector


def text(value: Any) -> str | None:
    if value is None:
        return None
    value = " ".join(str(value).split())
    return value or None


def first(page: Selector, query: str) -> str | None:
    try:
        return text(page.css(query).get())
    except Exception:
        return None


def first_many(page: Selector, queries: list[str]) -> str | None:
    for query in queries:
        value = first(page, query)
        if value:
            return value
    return None


def main() -> int:
    payload = json.load(sys.stdin)
    html = payload.get("html")
    url = payload.get("url", "")
    if not isinstance(html, str) or len(html.encode("utf-8")) > 12 * 1024 * 1024:
        raise ValueError("html must be a string no larger than 12 MiB")
    page = Selector(html, url=url)
    result = {
        "title": first_many(page, ['meta[property="og:title"]::attr(content)', 'meta[name="twitter:title"]::attr(content)', 'h1::text', 'title::text']),
        "description": first_many(page, ['meta[property="og:description"]::attr(content)', 'meta[name="description"]::attr(content)', 'main p::text', 'article p::text']),
        "image": first_many(page, ['meta[property="og:image"]::attr(content)', 'meta[name="twitter:image"]::attr(content)']),
        "price": first_many(page, ['meta[property="product:price:amount"]::attr(content)', 'meta[itemprop="price"]::attr(content)', '[itemprop="price"]::text']),
        "currency": first_many(page, ['meta[property="product:price:currency"]::attr(content)', 'meta[itemprop="priceCurrency"]::attr(content)']),
        "availability": first_many(page, ['link[itemprop="availability"]::attr(href)', 'meta[property="product:availability"]::attr(content)', '[itemprop="availability"]::text']),
        "parser": "scrapling-selector",
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
