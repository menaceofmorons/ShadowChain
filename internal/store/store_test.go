package store_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/menaceofmorons/ShadowChain/internal/store"
)

func TestTenantParameterRequired(t *testing.T) {
	contextType := reflect.TypeFor[context.Context]()
	tenantType := reflect.TypeFor[store.TenantID]()
	interfaces := []reflect.Type{
		reflect.TypeFor[store.SignatureRepository](),
		reflect.TypeFor[store.JumpRepository](),
		reflect.TypeFor[store.SnapshotReader](),
	}
	for _, iface := range interfaces {
		if iface.NumMethod() == 0 {
			t.Errorf("%s has no methods", iface.Name())
		}
		for i := range iface.NumMethod() {
			method := iface.Method(i)
			fn := method.Type
			if fn.NumIn() < 2 || fn.In(0) != contextType || fn.In(1) != tenantType {
				t.Errorf("%s.%s must take (context.Context, store.TenantID, ...)", iface.Name(), method.Name)
			}
		}
	}
}
