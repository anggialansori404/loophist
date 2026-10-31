package model

import (
	"encoding/json"
	"strconv"
)

type HistoryPayload struct {
	URL       string `json:"url"`
	Title     string `json:"title"`
	VisitTime int64  `json:"visit_time"`
}

// UnmarshalJSON terima visit_time int, float (Chrome lastVisitTime), string, null, atau absen.
func (p *HistoryPayload) UnmarshalJSON(data []byte) error {
	type alias struct {
		URL       string `json:"url"`
		Title     string `json:"title"`
		VisitTime any    `json:"visit_time"`
	}
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	p.URL = a.URL
	p.Title = a.Title
	switch v := a.VisitTime.(type) {
	case nil:
	case float64:
		p.VisitTime = int64(v) // ponytail: truncate sub-ms; ceiling: math.Round bila butuh presisi
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			p.VisitTime = int64(f)
		}
	}
	return nil
}

type SyncMessage struct {
	Type     string         `json:"type"`      // HISTORY_VISITED, HEARTBEAT, SYNC_REQUEST, SYNC_RESPONSE
	ClientID string         `json:"client_id"` // Unique sender ID
	Browser  string         `json:"browser"`   // chrome, firefox, etc.
	Payload  HistoryPayload `json:"payload,omitempty"`
	// Request terisi hanya untuk SYNC_REQUEST; nil untuk tipe lama.
	Request *SyncRequestPayload `json:"request,omitempty"`
	// Response terisi hanya untuk SYNC_RESPONSE; nil untuk tipe lama.
	Response *SyncResponsePayload `json:"response,omitempty"`
}

// SyncRequestPayload isi pesan SYNC_REQUEST: klien baru minta histori sejak since_ms.
type SyncRequestPayload struct {
	RequestorID string `json:"requestor_id"`
	SinceMs     int64  `json:"since_ms"`
	MaxItems    int    `json:"max_items"`
}

// SyncResponsePayload isi pesan SYNC_RESPONSE: bulk histori untuk requestor.
// Items reuse HistoryPayload (termasuk UnmarshalJSON fleksibel visit_time).
type SyncResponsePayload struct {
	RequestorID string           `json:"requestor_id"`
	Items       []HistoryPayload `json:"items"`
}
