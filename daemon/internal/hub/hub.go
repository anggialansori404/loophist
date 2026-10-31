package hub

import (
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

type Client struct {
	ID      string
	Browser string
	Conn    *websocket.Conn
	Send    chan []byte
}

type Hub struct {
	clients    map[string]*Client
	broadcast  chan BroadcastPayload
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
}

type BroadcastPayload struct {
	SenderID string
	Data     []byte
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		broadcast:  make(chan BroadcastPayload, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) Register(c *Client) {
	h.register <- c
}

func (h *Hub) Unregister(c *Client) {
	h.unregister <- c
}

func (h *Hub) Broadcast(senderID string, data []byte) {
	h.broadcast <- BroadcastPayload{SenderID: senderID, Data: data}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.ID] = client
			h.mu.Unlock()
			log.Printf("[HUB] Client connected: %s (%s). Total clients: %d\n", client.ID, client.Browser, len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.ID]; ok {
				delete(h.clients, client.ID)
				close(client.Send)
			}
			h.mu.Unlock()
			log.Printf("[HUB] Client disconnected: %s. Total clients: %d\n", client.ID, len(h.clients))

		case msg := <-h.broadcast:
			var slow []string
			h.mu.RLock()
			for id, client := range h.clients {
				// Cegah echo back ke client pengirim
				if id == msg.SenderID {
					continue
				}
				select {
				case client.Send <- msg.Data:
				default:
					slow = append(slow, id)
				}
			}
			h.mu.RUnlock()
			if len(slow) > 0 {
				h.mu.Lock()
				for _, id := range slow {
					if client, ok := h.clients[id]; ok {
						delete(h.clients, id)
						close(client.Send)
					}
				}
				h.mu.Unlock()
			}
		}
	}
}
