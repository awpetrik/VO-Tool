#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

import requests
from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

console = Console()


def _timestamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _iter_sse_events(response: requests.Response) -> Iterator[dict[str, Any]]:
    data_lines: list[str] = []

    for raw_line in response.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue

        line = raw_line.strip("\r")
        if not line:
            if not data_lines:
                continue
            payload = "\n".join(data_lines)
            data_lines.clear()
            try:
                yield json.loads(payload)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid SSE payload: {payload}") from exc
            continue

        if line.startswith("data:"):
            data_lines.append(line[5:].strip())

    if data_lines:
        payload = "\n".join(data_lines)
        try:
            yield json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid SSE payload: {payload}") from exc


def _run_caption(args: argparse.Namespace) -> int:
    api_url = f"{args.api_base.rstrip('/')}/caption"
    source = Path(args.file)
    if not source.exists():
        console.print(f"[red]Audio file not found:[/red] {source}")
        return 1

    form_data = {
        "language": args.language,
        "granularity": args.granularity,
        "max_chars": str(args.max_chars),
        "model": args.model,
    }

    with source.open("rb") as f:
        files = {"file": (source.name, f, "application/octet-stream")}
        with requests.post(api_url, data=form_data, files=files, stream=True, timeout=0) as res:
            if res.status_code != 200:
                console.print(f"[red]Caption request failed:[/red] HTTP {res.status_code}")
                console.print(res.text)
                return 1

            result_payload: dict[str, Any] | None = None

            with Progress(
                SpinnerColumn(),
                TextColumn("[bold cyan]{task.description}"),
                BarColumn(bar_width=None),
                TaskProgressColumn(),
                TimeElapsedColumn(),
                console=console,
            ) as progress:
                task = progress.add_task("Starting caption job", total=100)

                for event in _iter_sse_events(res):
                    pct = int(event.get("pct", 0))
                    label = str(event.get("label", "Processing"))
                    step = str(event.get("step", "unknown"))
                    progress.update(task, completed=max(0, min(100, pct)), description=label)
                    console.print(f"[dim]{_timestamp()}[/dim] [{step}] {label}")

                    if step == "error":
                        error_text = str(event.get("error", label))
                        console.print(f"[red]Caption failed:[/red] {error_text}")
                        return 1

                    if step == "done":
                        result_payload = event.get("result")

            if not result_payload:
                console.print("[red]Caption finished without result payload.[/red]")
                return 1

            segments = result_payload.get("segments", [])
            detected_lang = result_payload.get("language_detected", "unknown")
            srt_text = result_payload.get("srt", "")
            console.print(
                f"[green]Done.[/green] language={detected_lang} segments={len(segments)}"
            )

            if args.save_json:
                out_json = Path(args.save_json)
                out_json.write_text(json.dumps(result_payload, indent=2), encoding="utf-8")
                console.print(f"[green]Saved JSON:[/green] {out_json}")

            if args.save_srt:
                out_srt = Path(args.save_srt)
                out_srt.write_text(srt_text, encoding="utf-8")
                console.print(f"[green]Saved SRT:[/green] {out_srt}")

    return 0


def _run_enhance(args: argparse.Namespace) -> int:
    api_url = f"{args.api_base.rstrip('/')}/enhance"
    source = Path(args.file)
    if not source.exists():
        console.print(f"[red]Audio file not found:[/red] {source}")
        return 1

    settings = {
        "noise_reduction": args.noise_reduction,
        "clarity": args.clarity,
        "de_reverb": args.de_reverb,
        "compression": args.compression,
        "normalize": args.normalize,
    }

    token: str | None = None

    with source.open("rb") as f:
        files = {"file": (source.name, f, "application/octet-stream")}
        data = {"settings": json.dumps(settings)}

        with requests.post(api_url, files=files, data=data, stream=True, timeout=0) as res:
            if res.status_code != 200:
                console.print(f"[red]Enhance request failed:[/red] HTTP {res.status_code}")
                console.print(res.text)
                return 1

            with Progress(
                SpinnerColumn(),
                TextColumn("[bold magenta]{task.description}"),
                BarColumn(bar_width=None),
                TaskProgressColumn(),
                TimeElapsedColumn(),
                console=console,
            ) as progress:
                task = progress.add_task("Starting enhance job", total=100)

                for event in _iter_sse_events(res):
                    pct = int(event.get("pct", 0))
                    label = str(event.get("label", "Processing"))
                    step = str(event.get("step", "unknown"))
                    progress.update(task, completed=max(0, min(100, pct)), description=label)
                    console.print(f"[dim]{_timestamp()}[/dim] [{step}] {label}")

                    if step == "error":
                        error_text = str(event.get("error", label))
                        console.print(f"[red]Enhance failed:[/red] {error_text}")
                        return 1

                    if step == "done":
                        token = str(event.get("token", "")) or None

    if not token:
        console.print("[red]Enhance finished without result token.[/red]")
        return 1

    console.print(f"[green]Enhancement complete.[/green] token={token}")

    if args.download:
        dl_url = f"{args.api_base.rstrip('/')}/enhance/result/{token}"
        out_path = Path(args.download)
        with requests.get(dl_url, stream=True, timeout=120) as dl_res:
            if dl_res.status_code != 200:
                console.print(f"[red]Download failed:[/red] HTTP {dl_res.status_code}")
                console.print(dl_res.text)
                return 1
            out_path.write_bytes(dl_res.content)
            console.print(f"[green]Saved enhanced audio:[/green] {out_path}")

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="voxora-cli",
        description="CLI dashboard for Voxora backend jobs with real-time progress.",
    )
    parser.add_argument("--api-base", default="http://localhost:8001", help="Backend API base URL")

    subparsers = parser.add_subparsers(dest="command", required=True)

    caption = subparsers.add_parser("caption", help="Run caption transcription with SSE progress")
    caption.add_argument("--file", required=True, help="Path to source audio")
    caption.add_argument("--model", default="small", choices=["tiny", "base", "small", "large-v3"])
    caption.add_argument("--language", default="auto", choices=["auto", "id", "en"])
    caption.add_argument("--granularity", default="line", choices=["line", "word"])
    caption.add_argument("--max-chars", type=int, default=36)
    caption.add_argument("--save-json", help="Output path for caption JSON")
    caption.add_argument("--save-srt", help="Output path for SRT subtitle")
    caption.set_defaults(func=_run_caption)

    enhance = subparsers.add_parser("enhance", help="Run audio enhancement with SSE progress")
    enhance.add_argument("--file", required=True, help="Path to source audio")
    enhance.add_argument("--noise-reduction", type=int, default=80)
    enhance.add_argument("--clarity", type=int, default=70)
    enhance.add_argument("--de-reverb", type=int, default=30)
    enhance.add_argument("--compression", type=int, default=70)
    enhance.add_argument("--normalize", action=argparse.BooleanOptionalAction, default=True)
    enhance.add_argument("--download", help="Output path for enhanced WAV")
    enhance.set_defaults(func=_run_enhance)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
