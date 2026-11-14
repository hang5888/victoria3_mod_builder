"""Victoria 3 Mod Builder. Run `python app.py`, then use the page that opens in the browser."""
import argparse
import webbrowser

from backend.server import SETTINGS_FILE, make_server


def main():
    parser = argparse.ArgumentParser(description="Victoria 3 Mod Builder")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    parser.add_argument("--settings", default=str(SETTINGS_FILE), help="settings file to use")
    args = parser.parse_args()

    server = make_server(args.port, args.settings)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Victoria 3 Mod Builder: {url}")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
