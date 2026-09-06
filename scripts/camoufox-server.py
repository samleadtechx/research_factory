#!/usr/bin/env python3
import json
import os
import signal
import subprocess
import sys
from base64 import b64encode
from pathlib import Path

import orjson
from playwright._impl._driver import compute_driver_executable
from camoufox.virtdisplay import VirtualDisplay
from camoufox.utils import launch_options


def camel_case(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


def to_camel_case_dict(value: dict) -> dict:
    return {camel_case(key): item for key, item in value.items()}


def get_nodejs() -> str:
    nodejs = compute_driver_executable()[0]
    return nodejs[0] if isinstance(nodejs, tuple) else nodejs


def main() -> None:
    raw = sys.stdin.read().strip()
    options = json.loads(raw) if raw else {}
    virtual_display = None
    process = None

    def shutdown(_signum, _frame) -> None:
        if process and process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=5)
            except Exception:
                process.kill()
        if virtual_display:
            virtual_display.kill()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    if options.get("headless") == "virtual":
        virtual_display = VirtualDisplay(debug=bool(options.get("debug")))
        options["virtual_display"] = virtual_display.get()
        options["headless"] = False

    try:
        options.setdefault("env", os.environ.copy())
        config = launch_options(**options)
        nodejs = get_nodejs()
        driver_package = Path(nodejs).parent / "package"
        launch_script = Path(__file__).with_name("camoufox-launch-server.cjs")
        encoded_config = b64encode(orjson.dumps(to_camel_case_dict(config))).decode()

        process = subprocess.Popen(
            [nodejs, str(launch_script), str(driver_package)],
            cwd=driver_package,
            stdin=subprocess.PIPE,
            text=True,
        )
        process.communicate(input=encoded_config)
        raise RuntimeError(f"Server process terminated unexpectedly with exit code {process.returncode}")
    finally:
        if virtual_display:
            virtual_display.kill()


if __name__ == "__main__":
    main()
