.PHONY: all build-daemon build-ext clean run-daemon install-service

all: build-daemon

build-daemon:
	@echo "Building Go Daemon binary..."
	cd daemon && go build -ldflags="-s -w" -o ../bin/loophist-daemon cmd/daemon/main.go
	@echo "Daemon binary ready at ./bin/loophist-daemon"

build-ext:
	cd extension && npm run build

clean:
	rm -rf bin extension/.output

run-daemon:
	cd daemon && go run cmd/daemon/main.go

install-service:
	@mkdir -p ~/.config/systemd/user ~/.local/bin
	@cp bin/loophist-daemon ~/.local/bin/
	@cp scripts/loophist.service ~/.config/systemd/user/
	@systemctl --user daemon-reload
	@systemctl --user enable --now loophist.service
	@echo "LoopHist systemd user service installed and started!"
