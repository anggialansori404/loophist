package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/loophist/loophist-daemon/internal/hub"
	"github.com/loophist/loophist-daemon/pkg/model"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Tolak origin asing, izinkan kosong/ekstensi/loopback saja
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		for _, p := range []string{"chrome-extension://", "moz-extension://", "http://127.0.0.1", "http://localhost"} {
			if strings.HasPrefix(origin, p) {
				return true
			}
		}
		log.Printf("[WS] Origin ditolak: %q\n", origin)
		return false
	},
}

// max 1 SYNC_REQUEST per klien per 30 detik (minimal, di sini, bukan hub).
var (
	syncRequestCooldown = 30 * time.Second
	lastSyncRequest     = map[string]time.Time{}
)

func isHTTPURL(u string) bool {
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

func handleWebSocket(h *hub.Hub, w http.ResponseWriter, r *http.Request) {
	clientID := r.URL.Query().Get("client_id")
	browser := r.URL.Query().Get("browser")
	if clientID == "" {
		clientID = "anon-" + r.RemoteAddr
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Upgrade error: %v\n", err)
		return
	}

	client := &hub.Client{
		ID:      clientID,
		Browser: browser,
		Conn:    conn,
		Send:    make(chan []byte, 128),
	}

	h.Register(client)

	// Writer pump
	go func() {
		defer conn.Close()
		for msg := range client.Send {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				break
			}
		}
	}()

	// Reader pump
	defer func() {
		h.Unregister(client)
		conn.Close()
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var syncMsg model.SyncMessage
		if err := json.Unmarshal(message, &syncMsg); err != nil {
			log.Printf("[WS] Invalid JSON payload: %v\n", err)
			continue
		}

		if syncMsg.Type == "HEARTBEAT" {
			resp, err := json.Marshal(model.SyncMessage{Type: "HEARTBEAT", ClientID: "server", Browser: "daemon"})
			if err == nil {
				select {
				case client.Send <- resp:
				default:
					log.Printf("[WS] Send buffer full, HEARTBEAT reply dropped for %s\n", client.ID)
				}
			}
			continue
		}

		if syncMsg.Type == "HISTORY_VISITED" && syncMsg.Payload.URL != "" {
			log.Printf("[SYNC] [%s] -> %s\n", client.Browser, syncMsg.Payload.URL)
			h.Broadcast(client.ID, message)
			continue
		}

		// Fallback bentuk lama: ekstensi kirim SYNC_* lewat `payload`, normalkan ke kanonis
		if syncMsg.Type == "SYNC_REQUEST" && syncMsg.Request == nil {
			var raw struct {
				Payload *model.SyncRequestPayload `json:"payload"`
			}
			if err := json.Unmarshal(message, &raw); err == nil && raw.Payload != nil && raw.Payload.RequestorID != "" {
				syncMsg.Request = raw.Payload
			}
		}
		if syncMsg.Type == "SYNC_RESPONSE" && syncMsg.Response == nil {
			var raw struct {
				Payload *model.SyncResponsePayload `json:"payload"`
			}
			if err := json.Unmarshal(message, &raw); err == nil && raw.Payload != nil && raw.Payload.RequestorID != "" {
				syncMsg.Response = raw.Payload
			}
		}

		if syncMsg.Type == "SYNC_REQUEST" && syncMsg.Request != nil {
			now := time.Now()
			if last, ok := lastSyncRequest[client.ID]; ok && now.Sub(last) < syncRequestCooldown {
				continue
			}
			lastSyncRequest[client.ID] = now
			log.Printf("[BACKFILL] [%s] request since=%d max=%d\n", client.Browser, syncMsg.Request.SinceMs, syncMsg.Request.MaxItems)
			out, err := json.Marshal(syncMsg)
			if err != nil {
				continue
			}
			h.Broadcast(client.ID, out)
			continue
		}

		if syncMsg.Type == "SYNC_RESPONSE" && syncMsg.Response != nil {
			items := syncMsg.Response.Items
			if len(items) > 200 {
				items = items[:200]
			}
			kept := items[:0]
			for _, it := range items {
				if it.URL != "" && isHTTPURL(it.URL) {
					kept = append(kept, it)
				}
			}
			syncMsg.Response.Items = kept
			out, err := json.Marshal(syncMsg)
			if err != nil {
				continue
			}
			log.Printf("[BACKFILL] [%s] response %d items for %s\n", client.Browser, len(kept), syncMsg.Response.RequestorID)
			h.Broadcast(client.ID, out)
			continue
		}
	}
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8765", "Local service listen address")
	flag.Parse()

	syncHub := hub.NewHub()
	go syncHub.Run()

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok","service":"loophist-daemon"}`))
	})

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWebSocket(syncHub, w, r)
	})

	log.Printf("[DAEMON] LoopHist Hub listening on http://%s\n", *addr)
	if err := http.ListenAndServe(*addr, nil); err != nil {
		log.Fatalf("[DAEMON] Fatal error: %v\n", err)
	}
}
