package services

import (
	"github.com/debridge-finance/orbitdb-go/pkg/errors"
	"github.com/debridge-finance/orbitdb-go/services/ipfs"
	// "github.com/debridge-finance/orbitdb-go/services/orbitdb"
)

var DefaultConfig = Config{
	IPFS: &ipfs.DefaultConfig,
	// OrbitDB: &orbitdb.DefaultConfig,
}

//

type Config struct {
	IPFS *ipfs.Config
	// OrbitDB *orbitdb.Config
}

func (c *Config) SetDefaults() {
loop:
	for {
		switch {
		case c.IPFS == nil:
			c.IPFS = DefaultConfig.IPFS
		// case c.OrbitDB == nil:
		// 	c.OrbitDB = DefaultConfig.OrbitDB
		default:
			break loop
		}
	}

	c.IPFS.SetDefaults()
	// c.OrbitDB.SetDefaults()
}

func (c Config) Validate() error {
	err := c.IPFS.Validate()
	if err != nil {
		return errors.Wrap(err, "failed to validate ipfs configuration")
	}
	// err = c.OrbitDB.Validate()
	// if err != nil {
	// 	return errors.Wrap(err, "failed to validate orbitdb configuration")
	// }
	return nil
}
