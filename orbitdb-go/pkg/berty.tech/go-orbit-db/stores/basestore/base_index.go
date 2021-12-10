package basestore

import (
	"sync"

	ipfslog "github.com/debridge-finance/orbitdb-go/pkg/berty.tech/go-ipfs-log"

	"github.com/debridge-finance/orbitdb-go/pkg/berty.tech/go-orbit-db/iface"
)

type baseIndex struct {
	mu    sync.Mutex
	id    []byte
	index []ipfslog.Entry
}

func (b *baseIndex) Get(_ string) interface{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.index
}

func (b *baseIndex) UpdateIndex(log ipfslog.Log, entries []ipfslog.Entry) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.index = log.Values().Slice()
	return nil
}

// NewBaseIndex Creates a new basic index
func NewBaseIndex(publicKey []byte) iface.StoreIndex {
	return &baseIndex{
		id: publicKey,
	}
}

var _ iface.IndexConstructor = NewBaseIndex
