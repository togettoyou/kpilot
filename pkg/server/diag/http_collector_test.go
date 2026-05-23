package diag

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestHTTPCollectorMiddlewareBasic(t *testing.T) {
	gin.SetMode(gin.TestMode)
	hc := NewHTTPCollector()
	r := gin.New()
	r.Use(hc.Middleware())
	r.GET("/ok", func(c *gin.Context) { c.JSON(200, gin.H{"a": 1}) })
	r.GET("/boom", func(c *gin.Context) { c.JSON(500, gin.H{"e": "x"}) })

	srv := httptest.NewServer(r)
	defer srv.Close()
	for i := 0; i < 7; i++ {
		resp, err := http.Get(srv.URL + "/ok")
		if err != nil {
			t.Fatalf("get ok: %v", err)
		}
		_ = resp.Body.Close()
	}
	for i := 0; i < 3; i++ {
		resp, err := http.Get(srv.URL + "/boom")
		if err != nil {
			t.Fatalf("get boom: %v", err)
		}
		_ = resp.Body.Close()
	}

	out := hc.Collect()
	if out["requests_total"].(uint64) != 10 {
		t.Fatalf("requests_total: %v", out["requests_total"])
	}
	if out["status_5xx_total"].(uint64) != 3 {
		t.Fatalf("status_5xx_total: %v", out["status_5xx_total"])
	}
}

// TestHTTPCollectorRotationAndConcurrency hammers the collector under
// the race detector — multiple goroutines write while a rotation loop
// + a collector loop both read. The point is to catch any torn read /
// concurrent map mutation; we don't assert on exact rate values
// because the rotation timing is non-deterministic.
func TestHTTPCollectorRotationAndConcurrency(t *testing.T) {
	gin.SetMode(gin.TestMode)
	hc := NewHTTPCollector()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hc.RotateLoop(ctx)

	r := gin.New()
	r.Use(hc.Middleware())
	r.GET("/x", func(c *gin.Context) {
		// Vary latency to populate multiple histogram buckets.
		time.Sleep(time.Duration(c.Writer.Status()%3) * time.Millisecond)
		c.JSON(200, gin.H{})
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					resp, err := http.Get(srv.URL + "/x")
					if err == nil {
						_ = resp.Body.Close()
					}
				}
			}
		}()
	}
	// Reader loop racing with writers and the rotation goroutine.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				_ = hc.Collect()
			}
		}
	}()
	time.Sleep(200 * time.Millisecond)
	close(stop)
	wg.Wait()
}

func TestLatencyBucket(t *testing.T) {
	cases := []struct{ ms int64; want int }{
		{0, 0},
		{1, 0},
		{2, 2},
		{3, 2},
		{4, 3},
		{1000, 10},
		{maxLatencyMs, latBucketsN - 1},
		{maxLatencyMs * 2, latBucketsN - 1},
	}
	for _, c := range cases {
		got := latencyBucket(c.ms)
		if got != c.want {
			t.Errorf("latencyBucket(%d) = %d, want %d", c.ms, got, c.want)
		}
	}
}
