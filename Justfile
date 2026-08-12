set shell := ["zsh", "-cu"]

port := "4444"
unit := "book-reader-preview"
route := "book-reader"

up:
    systemctl --user stop {{unit}}.service 2>/dev/null || true
    systemctl --user reset-failed {{unit}}.service 2>/dev/null || true
    systemd-run --user --unit={{unit}} --collect --property=WorkingDirectory={{justfile_directory()}} -- npm run examples
    for attempt in {1..30}; do curl --fail --silent http://127.0.0.1:{{port}}/api/publications >/dev/null && break; sleep 0.5; done
    curl --fail-with-body --show-error --max-time 10 http://127.0.0.1:{{port}}/api/publications >/dev/null
    tunnel up {{port}} --name {{route}}

status:
    systemctl --user status {{unit}}.service --no-pager
    curl --fail-with-body --show-error --max-time 10 http://127.0.0.1:{{port}}/api/publications
    tunnel ls

refresh: up

down:
    systemctl --user stop {{unit}}.service 2>/dev/null || true
    tunnel ls
    tunnel down {{route}}
