package hub

import (
	"testing"
	"time"
)

// Broadcast dari A hanya diterima B, bukan A sendiri.
func TestBroadcastExcludeSender(t *testing.T) {
	h := NewHub()
	go h.Run()

	a := &Client{ID: "a", Browser: "chrome", Send: make(chan []byte, 4)}
	b := &Client{ID: "b", Browser: "firefox", Send: make(chan []byte, 4)}
	h.Register(a)
	h.Register(b)
	time.Sleep(100 * time.Millisecond) // beri waktu register diproses

	h.Broadcast("a", []byte("halo"))

	select {
	case got := <-b.Send:
		if string(got) != "halo" {
			t.Fatalf("B terima %q, mau %q", got, "halo")
		}
	case <-time.After(time.Second):
		t.Fatal("B tidak terima broadcast")
	}

	select {
	case got := <-a.Send:
		t.Fatalf("A ikut terima %q, harus dikecualikan", got)
	case <-time.After(100 * time.Millisecond):
	}
}
