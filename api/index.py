"""Vercel serverless entry point.

Vercel's @vercel/python runtime auto-detects a WSGI-compatible `app` callable
and serves it. All `vercel.json` does is route every non-static URL here.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import app  # noqa: E402,F401
