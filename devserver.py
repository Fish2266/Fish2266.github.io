import functools, http.server, pathlib, socketserver, sys

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()
    def log_message(self, *a): pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 4892
# Serve this folder: in the repo the site sits at the root.
handler = functools.partial(H, directory=str(pathlib.Path(__file__).resolve().parent))
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', port), handler) as httpd:
    httpd.serve_forever()
